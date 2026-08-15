/**
 * Gemini Adapter - Protocol handler for Google Gemini API.
 * Stateless - model config passed per-request.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { request as httpRequest, readWithDeadline } from '../utils/http.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

const CACHE_DIR = path.join(process.cwd(), 'logs', 'gemini-signatures');
let cleanedCache = false;

// Ensure the directory exists
async function ensureCacheDir() {
    try {
        if (!existsSync(CACHE_DIR)) {
            await fs.mkdir(CACHE_DIR, { recursive: true });
        }
    } catch (e) {
        logger.error(`Failed to create gemini signature cache dir: ${e.message}`, {}, 'GeminiAdapter');
    }
}

// Memory cache for super-fast lookups during a live session
const memorySignatures = new Map();

async function saveSignature(callId, signature) {
    if (!callId || !signature) return;
    memorySignatures.set(callId, signature);
    
    await ensureCacheDir();
    const filePath = path.join(CACHE_DIR, `${callId}.txt`);
    try {
        await fs.writeFile(filePath, signature, 'utf8');
    } catch (e) {
        logger.error(`Failed to save gemini signature for ${callId} to disk: ${e.message}`, {}, 'GeminiAdapter');
    }
}

async function getSignature(callId) {
    if (!callId) return null;
    if (memorySignatures.has(callId)) {
        return memorySignatures.get(callId);
    }
    
    const filePath = path.join(CACHE_DIR, `${callId}.txt`);
    try {
        if (existsSync(filePath)) {
            const signature = await fs.readFile(filePath, 'utf8');
            const trimmed = signature.trim();
            memorySignatures.set(callId, trimmed);
            return trimmed;
        }
    } catch (e) {
        // Silent catch for missing files/reading errors
    }
    return null;
}

async function pruneOldSignatures() {
    if (cleanedCache) return;
    cleanedCache = true;
    
    await ensureCacheDir();
    try {
        const files = await fs.readdir(CACHE_DIR);
        const now = Date.now();
        // Keep signatures for 7 days
        const maxAge = 7 * 24 * 60 * 60 * 1000;
        
        let pruned = 0;
        for (const file of files) {
            if (!file.endsWith('.txt')) continue;
            const filePath = path.join(CACHE_DIR, file);
            const stat = await fs.stat(filePath);
            if (now - stat.mtimeMs > maxAge) {
                await fs.unlink(filePath);
                pruned++;
            }
        }
        if (pruned > 0) {
            logger.info(`Pruned ${pruned} stale Gemini signatures from disk cache`, {}, 'GeminiAdapter');
        }
    } catch (e) {
        // Silent catch during startup pruning
    }
}

/**
 * Creates a Gemini adapter instance.
 * No config needed at factory time - pure protocol handler.
 */
export function createGeminiAdapter() {
    // Lazy prune stale signature cache on start
    pruneOldSignatures().catch(() => {});

    return {
        name: 'gemini',

        /**
         * Chat completion (non-streaming) via the Interactions API.
         * Stateless: store=false + full conversation history in `input`.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Standardized request
         */
        async chatComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            const model = adapterModel;

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required in modelConfig');
            }

            const payload = await buildInteractionPayload(request, capabilities);
            payload.model = model;

            const res = await httpRequest(`${endpoint}/interactions?key=${apiKey}`, {
                method: 'POST',
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (data.error) {
                const err = new Error(`Gemini API Error: ${data.error.message}`);
                err.status = data.error.code;
                throw err;
            }

            const steps = data.steps || [];
            let outText = '';
            const tool_calls = [];
            let pendingSignature = null;

            for (const step of steps) {
                if (step.type === 'thought') {
                    if (step.signature) pendingSignature = step.signature;
                    continue;
                }
                if (step.type === 'model_output') {
                    for (const item of step.content || []) {
                        if (item.type === 'text') outText += item.text;
                    }
                    continue;
                }
                if (step.type === 'function_call') {
                    // Cache the preceding thought signature keyed by the call id,
                    // so history echo can reconstruct the required thought step.
                    if (pendingSignature) {
                        await saveSignature(step.id, pendingSignature);
                        pendingSignature = null;
                    }
                    tool_calls.push({
                        id: step.id,
                        type: 'function',
                        function: {
                            name: step.name,
                            arguments: JSON.stringify(step.arguments ?? {})
                        }
                    });
                    continue;
                }
                // google_search_call / google_search_result / other server-side
                // tool steps are not surfaced to OpenAI-format clients.
            }

            const message = { role: 'assistant', content: outText || null };
            if (tool_calls.length > 0) message.tool_calls = tool_calls;

            const finishReason = (data.status === 'requires_action' || tool_calls.length > 0)
                ? 'tool_calls'
                : 'stop';

            return {
                id: `gemini-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: model,
                provider: 'gemini',
                choices: [{
                    index: 0,
                    message,
                    finish_reason: finishReason
                }],
                usage: {
                    prompt_tokens: data.usage?.total_input_tokens || 0,
                    completion_tokens: data.usage?.total_output_tokens || 0,
                    total_tokens: data.usage?.total_tokens || 0
                }
            };
        },

        /**
         * Streaming chat completion.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Standardized request
         */
        async *streamComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            const model = adapterModel;

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required in modelConfig');
            }

            const payload = await buildInteractionPayload(request, capabilities);
            payload.model = model;
            payload.stream = true;

            const res = await httpRequest(`${endpoint}/interactions?key=${apiKey}`, {
                method: 'POST',
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const processId = `gemini-${Date.now()}`;
            let buffer = '';

            // SSE state machine across the typed event stream:
            // interaction.created → (step.start → step.delta* → step.stop)+ → interaction.completed → done
            let stepType = null;              // active step: thought | model_output | function_call
            let pendingSignature = null;      // thought signature awaiting its function_call id
            let toolCallIndex = 0;            // OpenAI tool_calls index counter
            let currentToolId = null;
            let currentToolName = null;
            let argsBuffer = '';              // accumulated arguments_delta fragments
            let hasEmittedTools = false;
            let usage = null;

            const chunkFor = (delta, finishReason = null) => ({
                id: processId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                provider: 'gemini',
                choices: [{ index: 0, delta, finish_reason: finishReason }]
            });

            let finished = false;
            try {
                while (!finished) {
                    const { done, value } = await readWithDeadline(reader);
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data:')) continue;

                        const dataStr = trimmed.slice(5).trim();
                        if (dataStr === '[DONE]') {
                            finished = true;
                            break;
                        }

                        let event;
                        try {
                            event = JSON.parse(dataStr);
                        } catch {
                            continue;
                        }

                        const type = event.event_type;

                        if (type === 'interaction.completed') {
                            const u = event.interaction?.usage;
                            if (u) {
                                usage = {
                                    prompt_tokens: u.total_input_tokens || 0,
                                    completion_tokens: u.total_output_tokens || 0,
                                    total_tokens: u.total_tokens || 0
                                };
                            }
                            continue;
                        }

                        if (type === 'step.start') {
                            stepType = event.step?.type || null;
                            if (stepType === 'function_call') {
                                currentToolId = event.step.id;
                                currentToolName = event.step.name;
                                argsBuffer = '';
                                if (pendingSignature && currentToolId) {
                                    await saveSignature(currentToolId, pendingSignature);
                                    pendingSignature = null;
                                }
                                // Chunk 1: initialize tool call with id + name, no arguments
                                yield chunkFor({
                                    tool_calls: [{
                                        index: toolCallIndex,
                                        id: currentToolId,
                                        type: 'function',
                                        function: { name: currentToolName, arguments: '' }
                                    }]
                                });
                                hasEmittedTools = true;
                            }
                            continue;
                        }

                        if (type === 'step.delta') {
                            const delta = event.delta || {};
                            if (delta.type === 'text') {
                                if (delta.text) yield chunkFor({ content: delta.text });
                            } else if (delta.type === 'arguments_delta') {
                                argsBuffer += (delta.arguments ?? '');
                            } else if (delta.signature != null) {
                                pendingSignature = delta.signature;
                            }
                            // thought_summary, image, audio deltas — not surfaced to chat clients
                            continue;
                        }

                        if (type === 'step.stop') {
                            if (stepType === 'function_call') {
                                // Chunk 2: arguments for the tool call
                                yield chunkFor({
                                    tool_calls: [{
                                        index: toolCallIndex,
                                        function: { arguments: argsBuffer || '{}' }
                                    }]
                                });
                                toolCallIndex++;
                                currentToolId = null;
                                currentToolName = null;
                                argsBuffer = '';
                            }
                            stepType = null;
                            continue;
                        }

                        // interaction.created / interaction.status_update / done — ignored
                    }
                }

                // Terminal finish_reason chunk, then usage chunk.
                yield chunkFor({}, hasEmittedTools ? 'tool_calls' : 'stop');
                if (usage) {
                    yield {
                        id: processId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        provider: 'gemini',
                        choices: [],
                        usage
                    };
                }
            } finally {
                reader.releaseLock();
            }
        },

        /**
         * Create embeddings.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Standardized request
         */
        async createEmbedding(modelConfig, request) {
            const { endpoint, apiKey, adapterModel } = modelConfig;
            const model = adapterModel;

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required in modelConfig');
            }

            const input = Array.isArray(request.input) ? request.input : [request.input];

            const requests = input.map(text => ({
                model: `models/${model}`,
                content: { parts: [{ text }] }
            }));

            const res = await httpRequest(`${endpoint}/models/${model}:batchEmbedContents?key=${apiKey}`, {
                method: 'POST',
                body: JSON.stringify({ requests })
            });

            const data = await res.json();

            if (data.error) {
                throw new Error(`Gemini Embedding Error: ${data.error.message}`);
            }

            return {
                object: 'list',
                data: (data.embeddings || []).map((emb, index) => ({
                    object: 'embedding',
                    embedding: emb.values,
                    index
                })),
                model: model,
                usage: {}
            };
        },

        /**
         * List available models.
         * @param {Object} modelConfig - Model configuration (for API key/endpoint)
         */
        async listModels(modelConfig) {
            const { endpoint, apiKey } = modelConfig;

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required in modelConfig');
            }

            const res = await httpRequest(`${endpoint}/models?key=${apiKey}`);
            const data = await res.json();

            if (!data.models || !Array.isArray(data.models)) {
                throw new Error('[GeminiAdapter] Invalid response from API');
            }

            return data.models
                .filter(m => {
                    const id = m.name.replace('models/', '').toLowerCase();
                    // Exclude non-API models
                    return !['computer-use', 'deep-research', 'robotics'].some(p => id.includes(p));
                })
                .map(m => {
                    const id = m.name.replace('models/', '');
                    const idLower = id.toLowerCase();
                    const isEmbedding = idLower.includes('embedding') || idLower.includes('embed');
                    const isVision = !isEmbedding && !idLower.includes('aqa');

                    return {
                        id,
                        object: 'model',
                        owned_by: 'google',
                        capabilities: {
                            chat: !isEmbedding,
                            embeddings: isEmbedding,
                            structuredOutput: !isEmbedding,
                            streaming: !isEmbedding,
                            vision: isVision
                        }
                    };
                });
        }
    };
}

// Helper functions

/**
 * JSON Schema keywords that Gemini's API rejects.
 * Gemini only supports a minimal subset of JSON Schema for function declarations.
 * We take a defensive approach: strip all meta-schema annotations (keys starting with '$')
 * plus known VS Code / OpenAPI / Copilot extensions that Gemini rejects.
 *
 * This list is not exhaustive — any unknown key will cause a Gemini 400.
 * Strategy: blocklist known offenders + strip all $ prefix keys as a blanket catch-all,
 * since Gemini supports exactly zero JSON Schema meta-annotations.
 */
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
    '$comment', '$schema', '$id', '$ref', '$defs', 'definitions',
    'default', 'examples', 'example', 'deprecated', 'writeOnly', 'readOnly',
    'unevaluatedProperties', 'unevaluatedItems', 'contains',
    'patternProperties', 'propertyNames', 'dependencies', 'dependentRequired',
    'dependentSchemas', 'if', 'then', 'else', 'allOf', 'oneOf', 'not',
    'format',               // Gemini validates format strictly and rejects unknown formats
    'enumDescriptions',     // VS Code JSON Schema extension
    'markdownDescription',  // VS Code JSON Schema extension
    'markdownEnumDescriptions', // VS Code JSON Schema extension
    'doNotSuggest',         // VS Code / OpenAPI extension
]);

function sanitizeSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) {
        return schema.map(sanitizeSchemaForGemini);
    }
    const cleaned = {};
    for (const [key, value] of Object.entries(schema)) {
        // Blanket strip all $ prefix keys (meta-schema annotations, no known $ key is valid for Gemini)
        if (key.startsWith('$')) continue;
        if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
        // Strip any key starting with known vendor extension prefixes
        if (key.startsWith('x-') || key.startsWith('X-')) continue;
        cleaned[key] = sanitizeSchemaForGemini(value);
    }
    return cleaned;
}

function buildInteractionTools(openAiTools) {
    if (!openAiTools || !openAiTools.length) return undefined;

    const functions = openAiTools
        .filter(t => t.type === 'function' && t.function)
        .map(t => {
            const f = t.function;
            const decl = {
                type: 'function',
                name: f.name,
                description: f.description || ''
            };
            if (f.parameters) {
                decl.parameters = sanitizeSchemaForGemini(f.parameters);
            }
            return decl;
        });

    return functions.length > 0 ? functions : undefined;
}

async function buildInteractionPayload(request, capabilities) {
    const messages = request.messages || [];
    const systemMsg = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    // Resolve each tool result's name from the assistant tool_calls it belongs
    // to. OpenAI-format tool messages carry only tool_call_id (no name), but the
    // Interactions API's function_result step REQUIRES a name matching the
    // preceding function_call — a missing or mismatched name is a 400.
    const callIdToName = new Map();
    for (const m of otherMessages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (tc.id && tc.function?.name) callIdToName.set(tc.id, tc.function.name);
            }
        }
    }

    const input = [];
    for (const m of otherMessages) {
        input.push(...await buildInputSteps(m, callIdToName));
    }

    const payload = {
        input,
        store: false
    };

    if (systemMsg) {
        payload.system_instruction = String(systemMsg.content);
    }

    // The Interactions API has no tool_choice/tool_config field. A request for
    // 'none' is honoured by omitting tools entirely; other choices map to the
    // default (model decides) behaviour.
    if (request.tools && request.tool_choice !== 'none') {
        const mappedTools = buildInteractionTools(request.tools);
        if (mappedTools) {
            payload.tools = mappedTools;
        }
    }

    const generationConfig = {};

    if (request.maxTokens != null) {
        generationConfig.max_output_tokens = request.maxTokens;
    }

    if (typeof request.temperature === 'number') {
        generationConfig.temperature = request.temperature;
    }

    if (typeof request.top_p === 'number') {
        generationConfig.top_p = request.top_p;
    }

    if (typeof request.top_k === 'number') {
        generationConfig.top_k = request.top_k;
    }

    if (Array.isArray(request.stop) && request.stop.length > 0) {
        generationConfig.stop_sequences = request.stop;
    }

    if (request.seed != null) {
        generationConfig.seed = request.seed;
    }

    if (request.enable_thinking != null) {
        // thinking_level enum: low | medium | high (gemini 3.x dropped 'minimal').
        // 'low' is the floor — thinking cannot be fully disabled on this model.
        generationConfig.thinking_level = request.enable_thinking ? 'high' : 'low';
    }

    if (Object.keys(generationConfig).length > 0) {
        payload.generation_config = generationConfig;
    }

    if (request.schema && capabilities?.structuredOutput) {
        payload.response_format = [{
            type: 'text',
            mime_type: 'application/json',
            schema: request.schema
        }];
    }

    return payload;
}

async function buildInputSteps(message, callIdToName) {
    // Tool messages carry the function result. The Interactions API requires the
    // originating thought + function_call steps to precede it (handled by the
    // assistant tool_calls branch below).
    if (message.role === 'tool') {
        // The function_result name MUST match the function_call name. OpenAI-format
        // tool messages omit `name`, so resolve it from the assistant tool_calls
        // (keyed by call id). A function_result without a valid name is a 400, so
        // drop it when the name cannot be resolved.
        const name = callIdToName.get(message.tool_call_id) || message.name;
        if (!name) {
            return [];
        }
        return [{
            type: 'function_result',
            call_id: message.tool_call_id,
            name,
            result: [{ type: 'text', text: String(message.content || '') }]
        }];
    }

    // Assistant tool_calls echo back as thought + function_call steps. Gemini
    // rejects a function_call without its preceding thought, so the signature is
    // resolved from the filesystem cache keyed by the (native) call id.
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const steps = [];
        for (const tc of message.tool_calls) {
            if (tc.type !== 'function' || !tc.function) continue;

            let args = null;
            if (tc.function.arguments) {
                try { args = JSON.parse(tc.function.arguments); } catch {
                    args = null;
                }
            }

            const sig = await getSignature(tc.id);
            if (sig && args) {
                steps.push({ type: 'thought', signature: sig });
                steps.push({
                    type: 'function_call',
                    id: tc.id,
                    name: tc.function.name,
                    arguments: args
                });
            }
            // No cached signature (pruned or pre-cache history): the call cannot
            // be echoed. Drop it — the following tool message still carries the
            // result, which the model can use without the call frame.
        }
        return steps;
    }

    // Regular user / assistant text (possibly multimodal)
    const content = [];
    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (part.type === 'text') {
                content.push({ type: 'text', text: part.text });
            } else if (part.type === 'image_url') {
                const url = part.image_url?.url || '';
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                    content.push({
                        type: 'image',
                        mime_type: match[1],
                        data: match[2]
                    });
                } else {
                    content.push({ type: 'text', text: '[Image: remote URL not supported]' });
                }
            } else {
                content.push({ type: 'text', text: String(part) });
            }
        }
    } else if (message.content) {
        content.push({ type: 'text', text: String(message.content) });
    }

    if (content.length === 0) return [];

    const stepType = message.role === 'assistant' ? 'model_output' : 'user_input';
    return [{ type: stepType, content }];
}
