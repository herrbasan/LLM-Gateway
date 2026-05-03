/**
 * Kimi Adapter - Dedicated handler for Kimi Code API.
 * Extends OpenAI-compatible protocol with Kimi-specific requirements.
 */

import { request as httpRequest } from '../utils/http.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

function formatMessages(messages) {
    if (!messages) return [];
    return messages.map(m => {
        // Handle array content (vision messages)
        if (Array.isArray(m.content)) {
            return {
                role: m.role,
                content: m.content.map(part => {
                    if (part.type === 'image_url') {
                        // Kimi requires base64 images, not URLs
                        const url = part.image_url?.url || part.image_url;
                        if (url?.startsWith('data:')) {
                            // Already base64
                            return { type: 'image_url', image_url: { url } };
                        }
                        // URL not supported - would need fetching/converting
                        return { type: 'text', text: `[Image: ${url}]` };
                    }
                    return part;
                })
            };
        }
        return m;
    });
}

export function createKimiAdapter() {
    return {
        name: 'kimi',

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities, headers: customHeaders } = modelConfig;
            const model = adapterModel || 'kimi-k2.5';

            const payload = {
                model,
                messages: formatMessages(request.messages || []),
                stream: false
            };

            if (request.maxTokens) {
                payload.max_tokens = request.maxTokens;
                payload.max_completion_tokens = request.maxTokens;
            }
            if (typeof request.temperature === 'number') payload.temperature = request.temperature;
            
            // Tools
            if (request.tools) payload.tools = request.tools;
            if (request.tool_choice) payload.tool_choice = request.tool_choice;

            if (request.schema && capabilities?.structuredOutput) {
                payload.response_format = {
                    type: 'json_schema',
                    json_schema: { name: 'response', strict: true, schema: request.schema }
                };
            }

            logger.info('Sending chat completion request', {
                endpoint,
                model,
                stream: false,
                max_tokens: payload.max_tokens ?? null,
                max_completion_tokens: payload.max_completion_tokens ?? null,
                temperature: payload.temperature ?? null,
                message_count: (payload.messages || []).length
            }, 'KimiAdapter');

            const headers = buildHeaders(apiKey, {}, customHeaders);
            const res = await httpRequest(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            
            if (data.error) {
                const err = new Error(`Kimi API Error: ${data.error.message}`);
                err.status = data.error.code || 500;
                throw err;
            }

            logger.info('Received chat completion response', {
                model,
                finish_reason: data?.choices?.[0]?.finish_reason ?? null,
                usage: data?.usage ?? null,
                content_chars: data?.choices?.[0]?.message?.content?.length ?? 0
            }, 'KimiAdapter');

            return {
                ...data,
                provider: 'kimi'
            };
        },

        /**
         * Streaming chat completion.
         */
        async *streamComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities, headers: customHeaders } = modelConfig;
            const model = adapterModel || 'kimi-k2.5';

            const payload = {
                model,
                messages: formatMessages(request.messages || []),
                stream: true
            };

            if (request.maxTokens) {
                payload.max_tokens = request.maxTokens;
                payload.max_completion_tokens = request.maxTokens;
            }
            if (typeof request.temperature === 'number') payload.temperature = request.temperature;
            
            // Tools
            if (request.tools) payload.tools = request.tools;
            if (request.tool_choice) payload.tool_choice = request.tool_choice;

            logger.info('Sending streaming chat request', {
                endpoint,
                model,
                stream: true,
                max_tokens: payload.max_tokens ?? null,
                max_completion_tokens: payload.max_completion_tokens ?? null,
                temperature: payload.temperature ?? null,
                message_count: (payload.messages || []).length
            }, 'KimiAdapter');

            const headers = buildHeaders(apiKey, { 'Accept': 'text/event-stream' }, customHeaders);
            const res = await httpRequest(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let chunkCount = 0;
            let contentChars = 0;
            let lastFinishReason = null;
            let finalUsage = null;
            let sawDoneMarker = false;

            try {
                let reasoningBuffer = '';
                let sentReasoning = false;
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        logger.info('Stream reader completed', {
                            model,
                            chunk_count: chunkCount,
                            content_chars: contentChars,
                            reasoning_chars: reasoningBuffer.length,
                            last_finish_reason: lastFinishReason,
                            saw_done_marker: sawDoneMarker,
                            usage: finalUsage
                        }, 'KimiAdapter');
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(':')) continue;
                        
                        if (trimmed.startsWith('data:')) {
                            const data = trimmed.slice(5).trimStart();
                            if (data === '[DONE]') {
                                sawDoneMarker = true;
                                // Flush any remaining reasoning
                                if (reasoningBuffer && !sentReasoning) {
                                    yield {
                                        id: `kimi-${Date.now()}`,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model,
                                        provider: 'kimi',
                                        choices: [{
                                            index: 0,
                                            delta: { reasoning_content: reasoningBuffer },
                                            finish_reason: null
                                        }]
                                    };
                                    sentReasoning = true;
                                }
                                logger.info('Stream received DONE marker', {
                                    model,
                                    chunk_count: chunkCount,
                                    content_chars: contentChars,
                                    reasoning_chars: reasoningBuffer.length,
                                    last_finish_reason: lastFinishReason,
                                    usage: finalUsage
                                }, 'KimiAdapter');
                                // DO NOT yield { data: '[DONE]' } as it fails schema validation
                                return;
                            }
                            try {
                                const parsed = JSON.parse(data);
                                
                                chunkCount++;
                                const delta = parsed.choices?.[0]?.delta;
                                const finishReason = parsed.choices?.[0]?.finish_reason;
                                if (finishReason !== undefined && finishReason !== null) {
                                    lastFinishReason = finishReason;
                                }
                                if (parsed.usage) {
                                    finalUsage = parsed.usage;
                                }
                                
                                if (delta) {
                                    // Handle reasoning_content accumulation
                                    if (delta.reasoning_content !== undefined) {
                                        reasoningBuffer += delta.reasoning_content;
                                        continue;
                                    }

                                    // When we get content or tools, first yield accumulated reasoning
                                    if ((delta.content || delta.tool_calls) && reasoningBuffer && !sentReasoning) {
                                        yield {
                                            id: parsed.id || `kimi-${Date.now()}`,
                                            object: 'chat.completion.chunk',
                                            created: parsed.created || Math.floor(Date.now() / 1000),
                                            model,
                                            provider: 'kimi',
                                            choices: [{
                                                index: 0,
                                                delta: { reasoning_content: reasoningBuffer },
                                                finish_reason: null
                                            }]
                                        };
                                        sentReasoning = true;
                                    }

                                    if (delta.content) {
                                        contentChars += delta.content.length;
                                    }

                                    // Skip empty deltas
                                    if (!delta.content && !delta.role && !delta.tool_calls && !parsed.choices?.[0]?.finish_reason) continue;
                                }
                                
                                parsed.provider = 'kimi';
                                yield parsed;
                            } catch (e) {
                                logger.warn('Failed to parse stream chunk', {
                                    model,
                                    error: e.message,
                                    raw_preview: data.slice(0, 300)
                                }, 'KimiAdapter');
                            }
                        }
                    }
                }
            } finally {
                logger.info('Stream closed', {
                    model,
                    chunk_count: chunkCount,
                    content_chars: contentChars,
                    reasoning_chars: buffer.length,
                    last_finish_reason: lastFinishReason,
                    saw_done_marker: sawDoneMarker,
                    usage: finalUsage
                }, 'KimiAdapter');
                reader.releaseLock();
            }
        },

        /**
         * Create embeddings - not supported by Kimi Code.
         */
        async createEmbedding(modelConfig, request) {
            throw new Error('[KimiAdapter] Embeddings not supported');
        },

        async countMessageTokens(messages, modelConfig) {
            const { apiKey, adapterModel, headers: customHeaders } = modelConfig;
            const model = adapterModel || 'kimi-k2.5';

            const tokenizerBases = resolveTokenizerEndpoints(modelConfig);
            if (tokenizerBases.length === 0) {
                return null;
            }

            const headers = buildHeaders(apiKey, {}, customHeaders);
            const payload = {
                model,
                messages: formatMessages(messages || [])
            };
            let lastError = null;

            for (const tokenizerBase of tokenizerBases) {
                try {
                    const res = await httpRequest(`${tokenizerBase}/tokenizers/estimate-token-count`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(payload)
                    });

                    const data = await res.json();
                    const totalTokens = data?.data?.total_tokens;
                    if (typeof totalTokens !== 'number') {
                        throw new Error('[KimiAdapter] Invalid response from token estimate API');
                    }

                    return totalTokens;
                } catch (error) {
                    lastError = error;
                }
            }

            throw lastError || new Error('[KimiAdapter] Token estimate failed');
        },

        /**
         * Generate image - not supported by Kimi Code.
         */
        async generateImage(modelConfig, request) {
            throw new Error('[KimiAdapter] Image generation not supported');
        },

        /**
         * Synthesize speech - not supported by Kimi Code.
         */
        async synthesizeSpeech(modelConfig, request) {
            throw new Error('[KimiAdapter] TTS not supported');
        },

        /**
         * Generate video - not supported by Kimi Code.
         */
        async generateVideo(modelConfig, request) {
            throw new Error('[KimiAdapter] Video generation not supported');
        },

        /**
         * List available models.
         */
        async listModels(modelConfig) {
            const { endpoint, apiKey, headers: customHeaders } = modelConfig;
            const headers = buildHeaders(apiKey, {}, customHeaders);

            const res = await httpRequest(`${endpoint}/models`, { headers });
            const data = await res.json();

            if (!data.data || !Array.isArray(data.data)) {
                throw new Error('[KimiAdapter] Invalid response from API');
            }

            return data.data.map(m => ({
                id: m.id,
                object: 'model',
                owned_by: 'kimi',
                capabilities: {
                    chat: true,
                    embeddings: false,
                    structuredOutput: true,
                    streaming: true,
                    vision: false
                }
            }));
        }
    };
}

function buildHeaders(apiKey, extra = {}, custom = {}) {
    const headers = { ...extra, ...custom };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    // Ensure User-Agent is set for Kimi Code
    if (!headers['User-Agent']) {
        headers['User-Agent'] = 'Kilo-Code/1.0';
    }
    return headers;
}

function resolveTokenizerEndpoints(modelConfig = {}) {
    const explicitEndpoint = normalizeBaseUrl(modelConfig.tokenizerEndpoint);
    if (explicitEndpoint) {
        return [explicitEndpoint];
    }

    return [];
}

function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    return value.replace(/\/+$/, '');
}
