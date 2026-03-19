/**
 * Ollama Adapter - Protocol handler for Ollama API.
 * Stateless - model config passed per-request.
 */

import { request as httpRequest } from '../utils/http.js';

export function createOllamaAdapter() {
    return {
        name: 'ollama',

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            const { endpoint, adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'llama2';

            const payload = {
                model,
                messages: formatMessages(request.messages),
                stream: false,
                options: {}
            };

            if (request.maxTokens) payload.options.num_predict = request.maxTokens;
            if (typeof request.temperature === 'number') payload.options.temperature = request.temperature;
            if (request.schema && capabilities?.structuredOutput) payload.format = request.schema;

            const res = await httpRequest(`${endpoint}/api/chat`, {
                method: 'POST',
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            return {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                provider: 'ollama',
                choices: [{
                    index: 0,
                    message: data.message || { role: 'assistant', content: '' },
                    finish_reason: data.done_reason || 'stop'
                }],
                usage: {
                    prompt_tokens: data.prompt_eval_count || 0,
                    completion_tokens: data.eval_count || 0,
                    total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
                }
            };
        },

        /**
         * Streaming chat completion.
         */
        async *streamComplete(modelConfig, request) {
            const { endpoint, adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'llama2';

            const payload = {
                model,
                messages: formatMessages(request.messages),
                stream: true,
                options: {}
            };

            if (request.maxTokens) payload.options.num_predict = request.maxTokens;
            if (typeof request.temperature === 'number') payload.options.temperature = request.temperature;

            const res = await httpRequest(`${endpoint}/api/chat`, {
                method: 'POST',
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const processId = `chatcmpl-${Date.now()}`;
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
                        if (!trimmed) continue;

                        let data;
                        try {
                            data = JSON.parse(trimmed);
                        } catch (e) {
                            continue;
                        }

                        const chunk = {
                            id: processId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model,
                            choices: [{
                                index: 0,
                                delta: data.message || {},
                                finish_reason: data.done ? (data.done_reason || 'stop') : null
                            }]
                        };

                        yield chunk;
                        if (data.done) return;
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
            const model = adapterModel || 'nomic-embed-text';

            const input = Array.isArray(request.input) ? request.input : [request.input];
            const results = [];
            let totalPromptTokens = 0;

            for (let i = 0; i < input.length; i++) {
                const payload = { model, prompt: input[i] };
                const res = await httpRequest(`${endpoint}/api/embeddings`, {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });
                const data = await res.json();

                results.push({
                    object: 'embedding',
                    embedding: data.embedding,
                    index: i
                });
                totalPromptTokens += data.prompt_eval_count || 0;
            }

            return {
                object: 'list',
                data: results,
                model,
                usage: { prompt_tokens: totalPromptTokens, total_tokens: totalPromptTokens }
            };
        },

        /**
         * Generate image - not supported by Ollama.
         */
        async generateImage(modelConfig, request) {
            throw new Error('[OllamaAdapter] Image generation not supported');
        },

        /**
         * Synthesize speech - not supported by Ollama.
         */
        async synthesizeSpeech(modelConfig, request) {
            throw new Error('[OllamaAdapter] TTS not supported');
        },

        /**
         * Generate video - not supported by Ollama.
         */
        async generateVideo(modelConfig, request) {
            throw new Error('[OllamaAdapter] Video generation not supported');
        },

        /**
         * List available models.
         */
        async listModels(modelConfig) {
            const { endpoint } = modelConfig;

            const res = await httpRequest(`${endpoint}/api/tags`);
            const json = await res.json();

            const embeddingPatterns = ['embed', 'nomic-embed', 'embedding'];
            const visionPatterns = [
                'vision', '-v', 'vl', '4v', 'llava', 'bakllava', 'moondream',
                'qwen-vl', 'gemma-3'
            ];

            return (json.models || []).map(m => {
                const id = m.name.toLowerCase();
                const isEmbedding = embeddingPatterns.some(p => id.includes(p));
                const isTextChat = !isEmbedding;
                const isVision = isTextChat && visionPatterns.some(p => id.includes(p));

                return {
                    id: m.name,
                    object: 'model',
                    owned_by: 'ollama',
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

function formatMessages(messages) {
    if (!messages) return [];

    return messages.map(m => {
        if (Array.isArray(m.content)) {
            let textContent = '';
            let images = [];
            m.content.forEach(part => {
                if (part.type === 'text') textContent += part.text;
                if (part.type === 'image_url') {
                    const url = part.image_url.url;
                    const match = url.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) images.push(match[2]);
                }
            });
            return { role: m.role, content: textContent, images: images.length > 0 ? images : undefined };
        }
        return { role: m.role, content: String(m.content || '') };
    });
}
