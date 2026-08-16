/**
 * OpenAI Responses API Adapter
 * Protocol handler for OpenAI's newer Responses API endpoint (/v1/responses).
 * 
 * The Responses API uses a different format from Chat Completions:
 * - `input` array instead of `messages` (can include content items, tool calls, etc.)
 * - `previous_response_id` for stateful conversations
 * - Built-in tools: web_search, file_search, computer_use
 * - Output includes reasoning tokens and tool calls in a unified format
 * 
 * This adapter passes through native Responses API format without translation.
 */

import { request as httpRequest, readWithDeadline } from '../utils/http.js';

export function createResponsesAdapter() {
    return {
        name: 'responses',

        /**
         * Non-streaming response completion.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Responses API format request
         */
        async chatComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, headers: customHeaders } = modelConfig;

            const payload = buildPayload(request, modelConfig, adapterModel);
            const headers = buildHeaders(apiKey, {}, customHeaders);

            const baseEndpoint = endpoint?.replace(/\/$/, '') || 'https://api.openai.com/v1';
            const url = `${baseEndpoint}/responses`;

            const res = await httpRequest(url, {
                method: 'POST',
                headers,
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            
            if (data.error) {
                const err = new Error(`Responses API Error: ${data.error.message}`);
                err.status = data.error.code || data.error.status || 500;
                err.type = data.error.type;
                throw err;
            }

            return {
                ...data,
                provider: 'openai'
            };
        },

        /**
         * Streaming response completion.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Responses API format request
         */
        async *streamComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, headers: customHeaders } = modelConfig;

            const payload = buildPayload(request, modelConfig, adapterModel, true);
            const headers = buildHeaders(apiKey, { 'Accept': 'text/event-stream' }, customHeaders);

            const baseEndpoint = endpoint?.replace(/\/$/, '') || 'https://api.openai.com/v1';
            const url = `${baseEndpoint}/responses`;

            const res = await httpRequest(url, {
                method: 'POST',
                headers,
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errorStr = await res.text();
                throw new Error(`Responses API Streaming Error (${res.status}): ${errorStr}`);
            }

            // Guard against APIs that return 200 with JSON error bodies.
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('text/event-stream')) {
                const body = await res.text();
                let parsed;
                try { parsed = JSON.parse(body); } catch { /* not JSON */ }
                if (parsed?.error) {
                    const err = new Error(`Responses API Error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
                    err.status = parsed.error.code || 500;
                    throw err;
                }
                throw new Error(`Responses API unexpected response type: ${contentType}. Body: ${body.slice(0, 500)}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            resetToolCallTracking();

            try {
                while (true) {
                    const { done, value } = await readWithDeadline(reader);
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(':')) continue;

                        if (trimmed.startsWith('data: ')) {
                            const data = trimmed.slice(6);
                            if (data === '[DONE]') {
                                yield { provider: 'openai' };
                                return;
                            }

                            try {
                                const parsed = JSON.parse(data);
                                // Transform Responses API events to Chat Completions format
                                const transformed = transformStreamingEvent(parsed);
                                if (transformed) {
                                    // Copilot BYOK expects usage in a separate
                                    // choices:[] chunk, not on the finish chunk.
                                    const followUpUsage = transformed.__usage;
                                    delete transformed.__usage;
                                    yield transformed;
                                    if (followUpUsage) {
                                        yield {
                                            id: transformed.id,
                                            object: 'chat.completion.chunk',
                                            created: transformed.created,
                                            model: transformed.model,
                                            choices: [],
                                            usage: followUpUsage,
                                            provider: 'openai'
                                        };
                                    }
                                }
                            } catch (e) {
                                if (data.length > 0 && data !== '[DONE]') {
                                    console.error(`[ResponsesAdapter] Failed to parse SSE data line: ${data.slice(0, 200)}`);
                                }
                            }
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }
        },

        /**
         * Create embeddings - not supported by Responses API.
         * Falls back to standard OpenAI embeddings endpoint.
         */
        async createEmbedding(modelConfig, request) {
            throw new Error('[ResponsesAdapter] Embeddings not supported by Responses API. Use the openai adapter instead.');
        },

        /**
         * List available models.
         * Uses the standard OpenAI models endpoint.
         */
        async listModels(modelConfig) {
            const { endpoint, apiKey, headers: customHeaders } = modelConfig;
            
            const baseEndpoint = endpoint?.replace(/\/$/, '') || 'https://api.openai.com/v1';
            const headers = buildHeaders(apiKey, {}, customHeaders);

            const res = await httpRequest(`${baseEndpoint}/models`, { headers });
            const data = await res.json();

            if (!data.data || !Array.isArray(data.data)) {
                throw new Error('[ResponsesAdapter] Invalid response from API');
            }

            // Filter for models that support Responses API
            // Generally newer GPT-4 and GPT-4o models support Responses API
            const supportedPatterns = [
                'gpt-4o',
                'gpt-4.1',
                'o1',
                'o3',
                'o4'
            ];

            const excludedPatterns = [
                'embedding',
                'moderation',
                'dall-e',
                'tts',
                'whisper'
            ];

            return data.data
                .filter(m => {
                    const id = m.id.toLowerCase();
                    const isSupported = supportedPatterns.some(p => id.includes(p));
                    const isExcluded = excludedPatterns.some(p => id.includes(p));
                    return isSupported && !isExcluded;
                })
                .map(m => ({
                    id: m.id,
                    object: 'model',
                    owned_by: m.owned_by || 'openai',
                    capabilities: {
                        chat: true,
                        responses: true,
                        streaming: true,
                        structuredOutput: m.id.includes('gpt-4'),
                        vision: m.id.includes('vision') || m.id.includes('gpt-4o')
                    }
                }));
        }
    };
}

/**
 * Transform Responses API streaming events to Chat Completions format.
 * The Responses API has different event types that need to be mapped.
 */
// Per-stream tool call index map: Responses output items → OpenAI tool_calls
// index. Reset per stream. Keyed by item_id/call_id so argument deltas and the
// initial added event correlate to the same tool_calls[] index.
const toolCallIndexes = new Map();
let nextToolCallIndex = 0;

function toolCallIndexFor(itemId) {
    const key = itemId || `__auto_${nextToolCallIndex}`;
    if (!toolCallIndexes.has(key)) {
        toolCallIndexes.set(key, nextToolCallIndex++);
    }
    return toolCallIndexes.get(key);
}

function resetToolCallTracking() {
    toolCallIndexes.clear();
    nextToolCallIndex = 0;
}

// Translate Responses-API usage field names to Chat-Completions usage shape.
function translateUsage(usage) {
    if (!usage) return undefined;
    const prompt = usage.input_tokens ?? usage.prompt_tokens;
    const completion = usage.output_tokens ?? usage.completion_tokens;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: usage.total_tokens ?? ((prompt ?? 0) + (completion ?? 0))
    };
}

function transformStreamingEvent(event) {
    // Handle error events
    if (event.error) {
        return {
            error: event.error,
            provider: 'openai'
        };
    }

    const type = event.type;
    
    switch (type) {
        // Text delta events - map to Chat Completions delta format
        case 'response.output_text.delta':
            if (event.delta) {
                return {
                    choices: [{
                        index: 0,
                        delta: { content: event.delta }
                    }],
                    provider: 'openai'
                };
            }
            return null;

        // Tool call argument deltas - map to tool_calls[] (OpenAI spec).
        case 'response.function_call_arguments.delta':
            if (event.delta) {
                return {
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: toolCallIndexFor(event.item_id),
                                function: { arguments: event.delta }
                            }]
                        }
                    }],
                    provider: 'openai'
                };
            }
            return null;

        // Response creation/starting
        case 'response.created':
        case 'response.in_progress':
            return null;

        // Response completed: finish_reason chunk carries NO usage — Copilot
        // BYOK expects usage in a separate choices:[] chunk (see usageChunk below).
        case 'response.completed':
        case 'response.done': {
            // The Responses API has no 'tool_calls' status — the output array
            // tells us whether the model requested tools. Map function_call
            // output items to finish_reason:'tool_calls' (OpenAI Chat Completions
            // convention). Hardcoding 'stop' broke tool use for the chat app:
            // its client treats a 'stop' done as "model bailed on tool_calls"
            // and removes the pending tool bubble with empty content.
            const hasFunctionCalls = Array.isArray(event.response?.output)
                && event.response.output.some(item => item?.type === 'function_call');
            return {
                id: event.response?.id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: event.response?.model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: hasFunctionCalls ? 'tool_calls'
                        : (event.response?.status === 'completed' ? 'stop' : null)
                }],
                provider: 'openai',
                // Stashed for the stream loop to emit as a follow-up chunk.
                __usage: translateUsage(event.response?.usage)
            };
        }

        // Reasoning events (o-series models) - map to extended thinking format
        case 'response.reasoning_text.delta':
            if (event.delta) {
                return {
                    choices: [{
                        index: 0,
                        delta: { 
                            reasoning_content: event.delta,
                            content: null  // Reasoning is separate from content
                        }
                    }],
                    provider: 'openai'
                };
            }
            return null;

        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_summary.delta':
            // Summary of reasoning - can pass through as extended field
            if (event.delta) {
                return {
                    choices: [{
                        index: 0,
                        delta: { 
                            reasoning_summary: event.delta
                        }
                    }],
                    provider: 'openai'
                };
            }
            return null;

        // Refusal events - model refusing to answer
        case 'response.refusal.delta':
            if (event.delta) {
                return {
                    choices: [{
                        index: 0,
                        delta: { 
                            refusal: event.delta
                        }
                    }],
                    provider: 'openai'
                };
            }
            return null;

        case 'response.refusal.done':
            // Final refusal - include in delta
            return {
                choices: [{
                    index: 0,
                    delta: { 
                        refusal: event.refusal
                    }
                }],
                provider: 'openai'
            };

        // Tool call lifecycle events - emit tool_calls[] init chunk (id/type/name).
        case 'response.output_item.added':
            if (event.item?.type === 'function_call') {
                return {
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: toolCallIndexFor(event.item.id || event.item.call_id),
                                id: event.item.call_id || event.item.id,
                                type: 'function',
                                function: { name: event.item.name, arguments: '' }
                            }]
                        }
                    }],
                    provider: 'openai'
                };
            }
            return null;

        // Tool-specific events - pass through for extended handling
        case 'response.file_search_call.in_progress':
        case 'response.file_search_call.searching':
        case 'response.file_search_call.completed':
        case 'response.web_search_call.in_progress':
        case 'response.web_search_call.searching':
        case 'response.web_search_call.completed':
        case 'response.code_interpreter_call.in_progress':
        case 'response.code_interpreter_call.code_delta':
        case 'response.code_interpreter_call.code_done':
        case 'response.code_interpreter_call.interpreting':
        case 'response.code_interpreter_call.completed':
        case 'response.computer_call.in_progress':
        case 'response.computer_call.completed':
        case 'response.image_generation_call.in_progress':
        case 'response.image_generation_call.generating':
        case 'response.image_generation_call.completed':
            // These pass through in extended format for clients that want them
            return {
                ...event,
                object: 'chat.completion.chunk',
                provider: 'openai'
            };

        // Completion events for various output types
        case 'response.output_text.done':
        case 'response.function_call_arguments.done':
        case 'response.reasoning_text.done':
        case 'response.content_part.done':
        case 'response.output_item.done':
            return null;

        case 'response.content_part.added':
            return null;

        // Failed response
        case 'response.failed':
            return {
                error: {
                    message: 'Response generation failed',
                    type: 'response_failed',
                    details: event.response?.error
                },
                provider: 'openai'
            };

        // Unknown event type - pass through with provider
        default:
            return {
                ...event,
                provider: 'openai'
            };
    }
}

/**
 * Convert standard chat messages to Responses API input format.
 * Responses API uses similar format but as `input` instead of `messages`.
 */
function convertContentPart(part) {
    if (part.type === 'image_url') {
        return {
            type: 'input_image',
            image_url: part.image_url?.url || part.image_url
        };
    }
    if (part.type === 'text') {
        return { type: 'input_text', text: part.text };
    }
    return part;
}

function convertMessagesToInput(messages) {
    if (!messages || !Array.isArray(messages)) return [];

    return messages.flatMap(m => {
        // Tool result (CC format) → Responses API function_call_output
        if (m.role === 'tool') {
            return [{
                type: 'function_call_output',
                call_id: m.tool_call_id,
                output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            }];
        }

        // Assistant message with tool calls (CC format) → function_call items,
        // plus the assistant's own message content.
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            const items = m.tool_calls.map(tc => ({
                type: 'function_call',
                call_id: tc.id,
                name: tc.function?.name,
                arguments: tc.function?.arguments || ''
            }));
            if (m.content) {
                items.push({
                    role: 'assistant',
                    // The Responses API only accepts plain STRING content on
                    // assistant input messages — array parts (input_text) are
                    // rejected with "Invalid value: 'input_text'". Supported
                    // values are 'output_text'/'refusal' (server-produced),
                    // which a client can't fabricate. Flatten to the string.
                    content: typeof m.content === 'string'
                        ? m.content
                        : (Array.isArray(m.content)
                            ? m.content.map(p => p?.text ?? '').filter(Boolean).join('\n')
                            : String(m.content || ''))
                });
            }
            return items;
        }

        return [{
            role: m.role,
            content: Array.isArray(m.content) ? m.content.map(convertContentPart) : m.content
        }];
    });
}

/**
 * Convert Chat Completions format tools to Responses API format.
 * CC:   {type:'function', function:{name, description, parameters, strict}}
 * Resp: {type:'function', name, description, parameters, strict}
 * Native Responses-format tools pass through unchanged.
 */
function normalizeToolsToResponses(tools) {
    return tools.map(tool => {
        if (tool && tool.type === 'function' && tool.function && typeof tool.function === 'object') {
            const { name, description, parameters, strict } = tool.function;
            return { type: 'function', name, description, parameters, strict };
        }
        return tool;
    });
}

/**
 * Convert Chat Completions format tool_choice to Responses API format.
 * CC:   {type:'function', function:{name}}
 * Resp: {type:'function', name}
 */
function normalizeToolChoiceToResponses(toolChoice) {
    if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function'
        && toolChoice.function && typeof toolChoice.function.name === 'string') {
        return { type: 'function', name: toolChoice.function.name };
    }
    return toolChoice;
}

/**
 * Build the request payload for Responses API.
 * @param {Object} request - The incoming request
 * @param {Object} modelConfig - Model configuration from registry (for defaults/overrides)
 * @param {string} adapterModel - The model identifier
 * @param {boolean} isStreaming - Whether this is a streaming request
 */
function buildPayload(request, modelConfig, adapterModel, isStreaming = false) {
    const payload = {
        model: adapterModel || request.model
    };

    // Input is required for Responses API (replaces messages)
    // If `input` is provided, use it directly (native Responses API format)
    // Otherwise, convert from standard `messages` format
    if (request.input !== undefined) {
        payload.input = request.input;
    } else if (request.messages && request.messages.length > 0) {
        payload.input = convertMessagesToInput(request.messages);
    }

    // Stateful conversation support
    if (request.previous_response_id) {
        payload.previous_response_id = request.previous_response_id;
    }

    // GPT-5.6+ implicit prompt caching: the implicit breakpoint lands at the
    // LATEST user/tool message, so a growing conversation re-writes the ENTIRE
    // changing prompt to cache at 1.25× input rate every turn and never
    // cache-reads anything (verified live: cache_write_tokens ≈ input_tokens
    // on every large request). Fix: explicit mode + one breakpoint after the
    // stable system prefix. The stable prefix (system prompt + tools) gets
    // cached at the discounted read rate; the changing history stops being
    // written at 1.25×. Gated on session_id (the chat app sends it) so
    // unrelated requests are untouched. NOTE: cached tokens still count
    // toward TPM — this is a COST fix, not a rate-limit fix.
    const sessionKey = request.session_id || request.sessionId;
    if (sessionKey && Array.isArray(payload.input)) {
        payload.prompt_cache_options = { mode: 'explicit' };
        payload.prompt_cache_key = `chat:${sessionKey}`;
        const systemItem = payload.input.find(item => item && item.role === 'system');
        if (systemItem) {
            const systemText = Array.isArray(systemItem.content)
                ? systemItem.content.map(p => p?.text ?? '').join('')
                : systemItem.content;
            // Caching requires the rendered prefix before the breakpoint to be
            // ≥1024 tokens; below that the breakpoint is useless (docs).
            if (typeof systemText === 'string' && systemText.length >= 4096) {
                if (Array.isArray(systemItem.content)) {
                    const lastBlock = systemItem.content[systemItem.content.length - 1];
                    if (lastBlock && typeof lastBlock === 'object') {
                        lastBlock.prompt_cache_breakpoint = { mode: 'explicit' };
                    }
                } else {
                    systemItem.content = [{
                        type: 'input_text',
                        text: systemItem.content,
                        prompt_cache_breakpoint: { mode: 'explicit' }
                    }];
                }
            }
        }
    }

    // Streaming
    if (isStreaming) {
        payload.stream = true;
    }

    // Standard parameters
    if (typeof request.temperature === 'number') {
        payload.temperature = request.temperature;
    }
    if (typeof request.top_p === 'number') {
        payload.top_p = request.top_p;
    }
    
    // Max tokens - config override takes precedence, then request value
    const configMaxTokens = modelConfig?.maxTokens;
    if (configMaxTokens != null) {
        payload.max_output_tokens = configMaxTokens;
    } else if (request.max_tokens != null) {
        payload.max_output_tokens = request.max_tokens;
    } else if (request.max_output_tokens != null) {
        payload.max_output_tokens = request.max_output_tokens;
    }

    // Tools - convert Chat Completions format ({type:'function', function:{name,...}})
    // to Responses API format ({type:'function', name, ...}) when needed.
    // Native Responses-format tools pass through unchanged.
    if (request.tools && request.tools.length > 0) {
        payload.tools = normalizeToolsToResponses(request.tools);
    }
    if (request.tool_choice !== undefined) {
        payload.tool_choice = normalizeToolChoiceToResponses(request.tool_choice);
    }

    // Built-in tools (web_search, file_search, etc.)
    if (request.instructions) {
        payload.instructions = request.instructions;
    }
    if (request.text?.format) {
        payload.text = request.text;
    }

    // Reasoning configuration (for o-series models)
    if (request.reasoning) {
        payload.reasoning = request.reasoning;
    }
    if (request.reasoning_effort != null) {
        // Router validated against declared thinkingLevels — pass the enum through.
        payload.reasoning = {
            ...(payload.reasoning || {}),
            effort: request.reasoning_effort
        };
    } else if (request.enable_thinking != null) {
        payload.reasoning = {
            effort: request.enable_thinking ? 'medium' : 'low'
        };
    }

    // Response format / structured output
    if (request.response_format) {
        payload.text = {
            ...(payload.text || {}),
            format: request.response_format
        };
    }

    // Metadata for tracking
    if (request.metadata) {
        payload.metadata = request.metadata;
    }

    // Include usage in response
    if (request.include !== undefined) {
        payload.include = request.include;
    }

    // NOTE: parallel_tool_calls is Chat Completions-only. The Responses API has no
    // such parameter (parallel tool calls are always enabled) and rejects unknown
    // fields, so it is intentionally dropped here.

    // Store output for stateful conversations
    if (typeof request.store === 'boolean') {
        payload.store = request.store;
    }

    // User identifier
    if (request.user) {
        payload.user = request.user;
    }

    // Config-level extra_body (applied to all requests for this model)
    if (modelConfig?.extraBody) {
        const { chat_template_kwargs, ...safeExtra } = modelConfig.extraBody;
        Object.assign(payload, safeExtra);
    }

    // Request-level extra_body (provider-specific extensions)
    // Strip chat_template_kwargs — Responses API doesn't support it;
    // thinking is handled via reasoning.effort above.
    if (request.extra_body) {
        const { chat_template_kwargs, ...safeExtra } = request.extra_body;
        Object.assign(payload, safeExtra);
    }

    // Strip parameters the model doesn't support (e.g. reasoning models reject temperature)
    const excludeParams = modelConfig?.capabilities?.excludeParams;
    if (Array.isArray(excludeParams)) {
        for (const key of excludeParams) {
            delete payload[key];
        }
    }

    return payload;
}

function buildHeaders(apiKey, extra = {}, custom = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...extra,
        ...custom
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}
