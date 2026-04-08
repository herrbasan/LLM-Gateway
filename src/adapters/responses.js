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

import { request as httpRequest } from '../utils/http.js';

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
            const { endpoint, apiKey, adapterModel, headers: customHeaders, hardTokenCap } = modelConfig;

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

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            // Hard token cap tracking
            let generatedTokens = 0;
            const tokenCap = hardTokenCap || modelConfig?.maxTokens;

            try {
                while (true) {
                    const { done, value } = await reader.read();
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
                                    // Hard token cap check
                                    if (tokenCap) {
                                        const content = transformed.choices?.[0]?.delta?.content || '';
                                        // Rough token estimation: ~4 chars per token for English
                                        const estimatedTokens = Math.ceil(content.length / 4);
                                        generatedTokens += estimatedTokens;
                                        
                                        if (generatedTokens >= tokenCap) {
                                            // Yield final chunk with finish_reason
                                            transformed.choices = transformed.choices || [];
                                            if (transformed.choices[0]) {
                                                transformed.choices[0].finish_reason = 'length';
                                                transformed.choices[0].delta = {};
                                            }
                                            yield transformed;
                                            return; // Stop generation
                                        }
                                    }
                                    
                                    yield transformed;
                                }
                            } catch (e) {
                                // Skip broken JSON
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
         * Generate image - not supported by Responses API.
         */
        async generateImage(modelConfig, request) {
            throw new Error('[ResponsesAdapter] Image generation not supported by Responses API. Use the openai adapter instead.');
        },

        /**
         * Synthesize speech - not supported by Responses API.
         */
        async synthesizeSpeech(modelConfig, request) {
            throw new Error('[ResponsesAdapter] Speech synthesis not supported by Responses API. Use the openai adapter instead.');
        },

        /**
         * Generate video - not supported by Responses API.
         */
        async generateVideo(modelConfig, request) {
            throw new Error('[ResponsesAdapter] Video generation not supported by Responses API. Use the openai adapter instead.');
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

        // Tool call events - map to function_call format
        case 'response.function_call_arguments.delta':
            if (event.delta) {
                return {
                    choices: [{
                        index: 0,
                        delta: { 
                            function_call: { arguments: event.delta }
                        }
                    }],
                    provider: 'openai'
                };
            }
            return null;

        // Response creation/starting
        case 'response.created':
        case 'response.in_progress':
            return {
                id: event.response?.id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: event.response?.model,
                choices: [],
                provider: 'openai'
            };

        // Response completed
        case 'response.completed':
        case 'response.done':
            return {
                id: event.response?.id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: event.response?.model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: event.response?.status === 'completed' ? 'stop' : null
                }],
                usage: event.response?.usage,
                provider: 'openai'
            };

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

        // Tool call lifecycle events - pass through for tool handling
        case 'response.output_item.added':
            if (event.item?.type === 'function_call') {
                return {
                    choices: [{
                        index: 0,
                        delta: {
                            function_call: {
                                name: event.item.name,
                                call_id: event.item.call_id
                            }
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
function convertMessagesToInput(messages) {
    if (!messages || !Array.isArray(messages)) return [];
    
    return messages.map(m => {
        // Handle array content (vision messages)
        if (Array.isArray(m.content)) {
            return {
                role: m.role,
                content: m.content.map(part => {
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
                })
            };
        }
        // Simple string content
        return {
            role: m.role,
            content: m.content
        };
    });
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
        model: adapterModel || request.model || 'gpt-4o'
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
    if (configMaxTokens !== undefined) {
        payload.max_output_tokens = configMaxTokens;
    } else if (request.max_tokens !== undefined) {
        payload.max_output_tokens = request.max_tokens;
    } else if (request.max_output_tokens !== undefined) {
        payload.max_output_tokens = request.max_output_tokens;
    }

    // Tools - can be custom functions or built-in tools
    if (request.tools && request.tools.length > 0) {
        payload.tools = request.tools;
    }
    if (request.tool_choice !== undefined) {
        payload.tool_choice = request.tool_choice;
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

    // Parallel tool calls
    if (typeof request.parallel_tool_calls === 'boolean') {
        payload.parallel_tool_calls = request.parallel_tool_calls;
    }

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
        Object.assign(payload, modelConfig.extraBody);
    }

    // Request-level extra_body (provider-specific extensions)
    // e.g., chat_template_kwargs for disabling thinking on Qwen models
    // Request-level overrides config-level
    if (request.extra_body) {
        Object.assign(payload, request.extra_body);
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
