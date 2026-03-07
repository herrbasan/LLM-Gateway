/**
 * OpenAI Adapter - Protocol handler for OpenAI-compatible APIs.
 * Stateless - model config passed per-request.
 */

import { request as httpRequest } from '../utils/http.js';

export function createOpenAIAdapter() {
    return {
        name: 'openai',

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'gpt-4';

            const payload = {
                model,
                messages: request.messages || [],
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

            const headers = buildHeaders(apiKey);
            const res = await httpRequest(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                const err = new Error(`OpenAI API Error: ${data.error.message}`);
                err.status = data.error.code || 500;
                throw err;
            }

            return {
                ...data,
                provider: 'openai'
            };
        },

        /**
         * Streaming chat completion.
         */
        async *streamComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'gpt-4';

            const payload = {
                model,
                messages: request.messages || [],
                stream: true
            };

            if (request.maxTokens) payload.max_tokens = request.maxTokens;
            if (typeof request.temperature === 'number') payload.temperature = request.temperature;

            const headers = buildHeaders(apiKey, { 'Accept': 'text/event-stream' });
            const res = await httpRequest(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

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
                            if (data === '[DONE]') return;
                            try {
                                const parsed = JSON.parse(data);
                                parsed.provider = 'openai';
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
         * Create embeddings.
         */
        async createEmbedding(modelConfig, request) {
            const { endpoint, apiKey, adapterModel } = modelConfig;
            const model = adapterModel || 'text-embedding-3-small';

            const payload = {
                input: Array.isArray(request.input) ? request.input : [request.input],
                model
            };

            const headers = buildHeaders(apiKey);
            const res = await httpRequest(`${endpoint}/embeddings`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`OpenAI Embedding Error: ${data.error.message}`);
            }

            return data;
        },

        /**
         * Generate image.
         */
        async generateImage(modelConfig, request) {
            const { endpoint, apiKey, adapterModel } = modelConfig;

            const payload = {
                model: adapterModel || 'dall-e-3',
                prompt: request.prompt,
                n: request.n || 1,
                size: request.size || '1024x1024',
                response_format: 'b64_json'
            };

            const headers = buildHeaders(apiKey);
            const res = await httpRequest(`${endpoint}/images/generations`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`OpenAI Image Error: ${data.error.message}`);
            }

            return {
                created: data.created,
                data: data.data.map(img => ({
                    b64_json: img.b64_json,
                    url: img.url,
                    revised_prompt: img.revised_prompt
                }))
            };
        },

        /**
         * Synthesize speech.
         */
        async synthesizeSpeech(modelConfig, request) {
            const { endpoint, apiKey, adapterModel } = modelConfig;

            const payload = {
                model: adapterModel || 'tts-1',
                input: request.input,
                voice: request.voice || 'alloy',
                response_format: request.response_format || 'mp3'
            };

            if (request.speed) payload.speed = request.speed;

            const headers = buildHeaders(apiKey);
            const res = await httpRequest(`${endpoint}/audio/speech`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            // Audio responses are binary
            const arrayBuffer = await res.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');

            return {
                audio: base64,
                mimeType: `audio/${payload.response_format}`
            };
        },

        /**
         * List available models.
         */
        async listModels(modelConfig) {
            const { endpoint, apiKey } = modelConfig;
            const headers = buildHeaders(apiKey);

            const res = await httpRequest(`${endpoint}/models`, { headers });
            const data = await res.json();

            if (!data.data || !Array.isArray(data.data)) {
                throw new Error('[OpenAIAdapter] Invalid response from API');
            }

            const embeddingPatterns = ['embed', 'embedding'];
            const moderationPatterns = ['moderation'];
            const visionPatterns = [
                'vision', '-v', 'vl', '4v', '4.6v', 'gpt-4o', 'gemini', 'claude-3',
                'llava', 'bakllava', 'moondream', 'moonlight',
                'qwen2.5-vl', 'qwen-vl', 'qwen3-vl', 'glm-4v', 'glm-4.6v', 'cogvlm',
                'gemma-3', 'grok-2-vision'
            ];

            return data.data
                .filter(m => {
                    const id = m.id.toLowerCase();
                    return !moderationPatterns.some(p => id.includes(p));
                })
                .map(m => {
                    const id = m.id.toLowerCase();
                    const isEmbedding = embeddingPatterns.some(p => id.includes(p));
                    const isTextChat = !isEmbedding;
                    const isVision = isTextChat && visionPatterns.some(p => id.includes(p));

                    return {
                        id: m.id,
                        object: 'model',
                        owned_by: 'openai',
                        capabilities: {
                            chat: isTextChat,
                            embeddings: isEmbedding,
                            structuredOutput: isTextChat,
                            streaming: isTextChat,
                            vision: isVision
                        }
                    };
                });
        }
    };
}

function buildHeaders(apiKey, extra = {}) {
    const headers = { ...extra };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}
