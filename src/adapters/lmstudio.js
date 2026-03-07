/**
 * LM Studio Adapter - Protocol handler for LM Studio API.
 * Stateless - model config passed per-request.
 */

import { request as httpRequest } from '../utils/http.js';

export function createLmStudioAdapter() {
    return {
        name: 'lmstudio',

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            const { endpoint, adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'local-model';

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

            const res = await httpRequest(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`LM Studio Error: ${data.error.message}`);
            }

            return { ...data, provider: 'lmstudio' };
        },

        /**
         * Streaming chat completion.
         */
        async *streamComplete(modelConfig, request) {
            const { endpoint, adapterModel } = modelConfig;
            const model = adapterModel || 'local-model';

            const payload = {
                model,
                messages: request.messages || [],
                stream: true
            };

            if (request.maxTokens) payload.max_tokens = request.maxTokens;
            if (typeof request.temperature === 'number') payload.temperature = request.temperature;

            const res = await httpRequest(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Accept': 'text/event-stream' },
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
                                parsed.provider = 'lmstudio';
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
            const { endpoint, adapterModel } = modelConfig;
            const model = adapterModel || 'text-embedding';

            const payload = {
                input: Array.isArray(request.input) ? request.input : [request.input],
                model
            };

            const res = await httpRequest(`${endpoint}/v1/embeddings`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`LM Studio Embedding Error: ${data.error.message}`);
            }

            return data;
        },

        /**
         * Generate image - not supported by LM Studio.
         */
        async generateImage(modelConfig, request) {
            throw new Error('[LMStudioAdapter] Image generation not supported');
        },

        /**
         * Synthesize speech - not supported by LM Studio.
         */
        async synthesizeSpeech(modelConfig, request) {
            throw new Error('[LMStudioAdapter] TTS not supported');
        },

        /**
         * List available models.
         */
        async listModels(modelConfig) {
            const { endpoint, capabilities } = modelConfig;
            const contextWindow = capabilities?.contextWindow || 4096;

            const res = await httpRequest(`${endpoint}/api/v1/models`);
            const json = await res.json();

            if (!json.models || !Array.isArray(json.models)) {
                throw new Error('[LMStudioAdapter] Invalid response from /api/v1/models');
            }

            return json.models.map(m => {
                const caps = m.capabilities ?? {};
                const isEmbedding = m.type === 'embedding';
                const isTextChat = m.type === 'llm';

                return {
                    id: m.key ?? m.id,
                    object: 'model',
                    owned_by: m.publisher ?? 'lmstudio',
                    capabilities: {
                        chat: isTextChat,
                        embeddings: isEmbedding,
                        structuredOutput: isTextChat,
                        streaming: isTextChat,
                        vision: caps.vision === true,
                        context_window: contextWindow
                    }
                };
            });
        }
    };
}
