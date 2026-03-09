/**
 * Kimi Adapter - Dedicated handler for Kimi Code API.
 * Extends OpenAI-compatible protocol with Kimi-specific requirements.
 */

import { request as httpRequest } from '../utils/http.js';

export function createKimiAdapter() {
    return {
        name: 'kimi',

        /**
         * Format messages for Kimi API - handles vision content.
         */
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

            if (request.maxTokens) payload.max_tokens = request.maxTokens;
            if (typeof request.temperature === 'number') payload.temperature = request.temperature;
            if (request.schema && capabilities?.structuredOutput) {
                payload.response_format = {
                    type: 'json_schema',
                    json_schema: { name: 'response', strict: true, schema: request.schema }
                };
            }

            const headers = buildHeaders(apiKey, {}, customHeaders);
            const res = await httpRequest(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            
            if (data.error) {
                const err = new Error(`Kimi API Error: ${data.error.message}`);
                err.status = data.error.code || 500;
                throw err;
            }

            // Transform reasoning_content to <think> wrapped format for consistent handling
            const message = data.choices?.[0]?.message;
            if (message?.reasoning_content) {
                if (message.content) {
                    // Both exist - wrap reasoning in think tags before content
                    message.content = `<think>${message.reasoning_content}</think>${message.content}`;
                } else {
                    // Only reasoning - wrap in think tags
                    message.content = `<think>${message.reasoning_content}</think>`;
                }
                delete message.reasoning_content;
            }

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

            if (request.maxTokens) payload.max_tokens = request.maxTokens;
            if (typeof request.temperature === 'number') payload.temperature = request.temperature;

            const headers = buildHeaders(apiKey, { 'Accept': 'text/event-stream' }, customHeaders);
            const res = await httpRequest(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            try {
                let reasoningBuffer = '';
                let sentReasoning = false;
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(':')) continue;
                        
                        if (trimmed.startsWith('data:')) {
                            const data = trimmed.slice(5).trimStart();
                            if (data === '[DONE]') {
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
                                            delta: { content: `<think>${reasoningBuffer}</think>` },
                                            finish_reason: null
                                        }]
                                    };
                                }
                                yield { data: '[DONE]' };
                                return;
                            }
                            try {
                                const parsed = JSON.parse(data);
                                const delta = parsed.choices?.[0]?.delta;
                                
                                if (delta) {
                                    // Handle reasoning_content accumulation
                                    if (delta.reasoning_content !== undefined) {
                                        reasoningBuffer += delta.reasoning_content;
                                        continue; // Don't yield reasoning chunks yet
                                    }
                                    
                                    // When we get content, first flush reasoning if any
                                    if (delta.content && reasoningBuffer && !sentReasoning) {
                                        delta.content = `<think>${reasoningBuffer}</think>${delta.content}`;
                                        sentReasoning = true;
                                    } else if (delta.content && !reasoningBuffer) {
                                        // No reasoning, just content
                                    }
                                    
                                    // Skip empty deltas
                                    if (!delta.content && !delta.role) continue;
                                }
                                
                                parsed.provider = 'kimi';
                                yield parsed;
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
         * Create embeddings - not supported by Kimi Code.
         */
        async createEmbedding(modelConfig, request) {
            throw new Error('[KimiAdapter] Embeddings not supported');
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
