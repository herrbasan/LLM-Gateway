/**
 * Gemini Adapter - Protocol handler for Google Gemini API.
 * Stateless - model config passed per-request.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { request as httpRequest, readWithDeadline } from '../utils/http.js';
import { getLogger } from '../utils/logger.js';
import { splitInstructions } from '../utils/system-messages.js';
import { sendWithToolContainment } from '../utils/tool-containment.js';

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

            const res = await sendWithToolContainment({
                adapter: 'gemini',
                model,
                payload,
                send: (body) => httpRequest(`${endpoint}/interactions?key=${apiKey}`, {
                    method: 'POST',
                    signal: request.signal,
                    body: JSON.stringify(body)
                })
            });

            const data = await res.json();

            if (data.error) {
                const err = new Error(`Gemini API Error: ${data.error.message}`);
                err.status = data.error.code;
                throw err;
            }

            // Terminal interaction statuses. A failed or cancelled interaction is
            // still an HTTP 200 carrying whatever steps exist, so reporting it as
            // a normal 'stop' would hand the client a successful empty answer.
            if (data.status === 'failed' || data.status === 'cancelled') {
                throw new Error(`Gemini interaction ${data.status}`);
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

            // 'incomplete' means the model used all of max_output_tokens — OpenAI's
            // 'length'. A pending tool call is the more specific signal and wins.
            let finishReason = data.status === 'incomplete' ? 'length' : 'stop';
            if (data.status === 'requires_action' || tool_calls.length > 0) finishReason = 'tool_calls';

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
                    total_tokens: data.usage?.total_tokens || 0,
                    // Implicit caching is best-effort and works with store:false,
                    // so this is the only place a caller can see whether it landed.
                    prompt_tokens_details: {
                        cached_tokens: data.usage?.total_cached_tokens || 0
                    }
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

            const res = await sendWithToolContainment({
                adapter: 'gemini',
                model,
                payload,
                send: (body) => httpRequest(`${endpoint}/interactions?key=${apiKey}`, {
                    method: 'POST',
                    signal: request.signal,
                    body: JSON.stringify(body)
                })
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
            let terminalStatus = null;        // last status seen (status_update / completed)

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

                        if (type === 'interaction.status_update') {
                            if (event.status) terminalStatus = event.status;
                            continue;
                        }

                        if (type === 'interaction.completed') {
                            const u = event.interaction?.usage;
                            // The event name is not a success signal: it carries
                            // requires_action (tool call pending) and failed/cancelled.
                            if (event.interaction?.status) terminalStatus = event.interaction.status;
                            if (u) {
                                usage = {
                                    prompt_tokens: u.total_input_tokens || 0,
                                    completion_tokens: u.total_output_tokens || 0,
                                    total_tokens: u.total_tokens || 0,
                                    prompt_tokens_details: {
                                        cached_tokens: u.total_cached_tokens || 0
                                    }
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

                        // interaction.created / done — ignored
                    }
                }

                // A stream that ended on failed/cancelled still delivered whatever
                // steps it produced before dying; finishing with 'stop' would
                // report that truncated answer as complete.
                if (terminalStatus === 'failed' || terminalStatus === 'cancelled') {
                    throw new Error(`Gemini interaction ${terminalStatus}`);
                }

                // Terminal finish_reason chunk, then usage chunk.
                let finishReason = hasEmittedTools ? 'tool_calls' : 'stop';
                if (terminalStatus === 'incomplete') finishReason = 'length';
                yield chunkFor({}, finishReason);
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

/**
 * Keys whose VALUE is a map of arbitrary names to subschemas. Inside one of these a
 * key is a property NAME, not a schema keyword: a tool may legitimately declare a
 * property called `oneOf`, `default`, `format` or `if`. Stripping those by name
 * deleted real data AND left `required` pointing at a property that no longer
 * existed, which Gemini rejects outright:
 *
 *   Invalid schema in function tool 'ask_user' parameters: specifies required field
 *   'oneOf' which is not defined in properties.
 *
 * VS Code's own `ask_user` schema has exactly such properties, so every Gemini turn
 * carrying tools died. The tools array is resent on every turn, so that is a dead
 * session, not a failed request.
 */
const NAME_MAPS = new Set(['properties']);
// `patternProperties` is deliberately NOT here: Gemini does not support the keyword
// at all, so dropping it wholesale is correct — and its inner names go with it.

/**
 * Gemini's validator requires every entry of `required` to exist in `properties`.
 * Any schema reaching this point must satisfy that, so it is enforced here rather
 * than left to the upstream: a name that names nothing is a rejection on every turn.
 * It should never fire once names are preserved above — if it does, the client's
 * schema is genuinely inconsistent and the dropped names are worth a WARN.
 */
function pruneDanglingRequired(schema, dropped) {
    if (!Array.isArray(schema.required)) return schema;
    const declared = schema.properties && typeof schema.properties === 'object'
        ? new Set(Object.keys(schema.properties))
        : new Set();
    const dangling = schema.required.filter(name => !declared.has(name));
    if (dangling.length === 0) return schema;

    dropped.push(...dangling);
    const kept = schema.required.filter(name => declared.has(name));
    if (kept.length > 0) schema.required = kept;
    else delete schema.required;
    return schema;
}

function sanitizeSchemaForGemini(schema, dropped = []) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) {
        return schema.map(entry => sanitizeSchemaForGemini(entry, dropped));
    }
    const cleaned = {};
    for (const [key, value] of Object.entries(schema)) {
        if (NAME_MAPS.has(key)) {
            const map = {};
            for (const [name, sub] of Object.entries(value ?? {})) {
                map[name] = sanitizeSchemaForGemini(sub, dropped);
            }
            cleaned[key] = map;
            continue;
        }
        // Blanket strip all $ prefix keys (meta-schema annotations, no known $ key is valid for Gemini)
        if (key.startsWith('$')) continue;
        if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
        // Strip any key starting with known vendor extension prefixes
        if (key.startsWith('x-') || key.startsWith('X-')) continue;
        cleaned[key] = sanitizeSchemaForGemini(value, dropped);
    }
    return pruneDanglingRequired(cleaned, dropped);
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
                const dropped = [];
                decl.parameters = sanitizeSchemaForGemini(f.parameters, dropped);
                if (dropped.length > 0) {
                    logger.warn('Tool schema named a required field that does not exist — dropped', {
                        tool: f.name,
                        dropped
                    }, 'GeminiAdapter');
                }
            }
            return decl;
        });

    return functions.length > 0 ? functions : undefined;
}

async function buildInteractionPayload(request, capabilities) {
    const { systemPrompt, messages: otherMessages } = splitInstructions(request.messages || []);

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

    // Tool calls dropped for a missing cached signature must also have their
    // function_result steps dropped — an orphaned result (call_id with no
    // preceding function_call in the timeline) is a 400 on every request.
    const droppedCallIds = new Set();
    const input = [];
    for (const m of otherMessages) {
        input.push(...await buildInputSteps(m, callIdToName, droppedCallIds));
    }

    // The Interactions API rejects any request whose input's FINAL step is
    // model_output ("Request contains an invalid argument", size- and
    // content-independent — verified 2026-09-24: a 1-char trailing
    // model_output on an otherwise-200 history 400s, a tiny 2-step history
    // ending in model_output 400s, mid-history model_output steps are fine).
    // Clients that append the model's previous reply before re-requesting
    // (retry after a failed turn, queued user interjection) end their history
    // exactly that way. Drop the trailing run and let the model regenerate.
    let trailingOutputs = 0;
    while (input.length > 0 && input[input.length - 1].type === 'model_output') {
        input.pop();
        trailingOutputs++;
    }
    if (trailingOutputs > 0) {
        logger.warn(`Dropped ${trailingOutputs} trailing model_output step(s): the Interactions API rejects an input ending with the model's own output`, {}, 'GeminiAdapter');
    }

    const payload = {
        input,
        store: false
    };

    if (systemPrompt !== null) {
        payload.system_instruction = systemPrompt;
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

    if (request.reasoning_effort != null) {
        // Effort → thinking_level. Model-specific clamping is handled by the
        // declared thinkingLevels in config — the value arriving here is already
        // valid for this model. xhigh/max have no Gemini equivalent → high.
        const levelMap = { none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
        generationConfig.thinking_level = levelMap[request.reasoning_effort] || 'high';
    } else if (request.enable_thinking != null) {
        // thinking_level enum: low | medium | high (gemini 3.x dropped 'minimal').
        // 'low' is the floor — thinking cannot be fully disabled on this model.
        generationConfig.thinking_level = request.enable_thinking ? 'high' : 'low';
    }

    // Strip parameters the model rejects. Gemini 3.6+ ignores sampling overrides
        // and Google's deprecation notice says upcoming models return 400 for them,
        // so a declared excludeParams has to be honoured here. The anthropic adapter
        // already does this; without the same pass the capability silently protected
        // nothing on this adapter, which is worse than not offering it — the config
        // would read as a guard that is not there.
        const excludeParams = capabilities?.excludeParams;
        if (Array.isArray(excludeParams)) {
            for (const key of excludeParams) delete generationConfig[key];
        }

        if (Object.keys(generationConfig).length > 0) {
            payload.generation_config = generationConfig;
        }

    if (request.schema && capabilities?.structuredOutput) {
        // Same traversal as the tool schemas, for the same reason: Gemini validates
        // this against its own schema subset, and a keyword it does not know rejects
        // the whole request.
        const dropped = [];
        payload.response_format = [{
            type: 'text',
            mime_type: 'application/json',
            schema: sanitizeSchemaForGemini(request.schema, dropped)
        }];
        if (dropped.length > 0) {
            logger.warn('Structured-output schema named a required field that does not exist — dropped', {
                dropped
            }, 'GeminiAdapter');
        }
    }

    return payload;
}

async function buildInputSteps(message, callIdToName, droppedCallIds) {
    // Tool messages carry the function result. The Interactions API requires the
    // originating thought + function_call steps to precede it (handled by the
    // assistant tool_calls branch below).
    if (message.role === 'tool') {
        if (droppedCallIds.has(message.tool_call_id)) {
            return [];
        }
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
            // be echoed. Drop it AND its function_result (tracked in
            // droppedCallIds) — an orphaned result is a 400.
            else {
                droppedCallIds.add(tc.id);
            }
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
