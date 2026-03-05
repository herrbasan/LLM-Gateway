import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

export function createOllamaAdapter(config) {
    const defaultCapabilities = {
        embeddings: true,
        structuredOutput: true,
        streaming: true,
        vision: true,
        ...config.capabilities
    };

    const base = createBaseAdapter('ollama', config, defaultCapabilities);
    const apiEndpoint = config.endpoint;
    if (!apiEndpoint) {
        throw new Error('Ollama adapter requires an endpoint');
    }

    const getModelOrThrow = (requestedModel) => {
        const model = requestedModel === 'auto' ? config.model : requestedModel;
        if (!model) throw new Error("Ollama adapter requires a model name.");
        return model;
    };

    const formatMessages = (messages, prompt, systemPrompt) => {
        let activeMessages = messages && Array.isArray(messages) ? messages : [];
        if (!messages) {
            if (systemPrompt) activeMessages.push({ role: 'system', content: systemPrompt });
            if (prompt) activeMessages.push({ role: 'user', content: prompt });
        }

        return activeMessages.map(m => {
            if (Array.isArray(m.content)) {
                let textContent = '';
                let images = [];
                m.content.forEach(part => {
                    if (part.type === 'text') textContent += part.text;
                    if (part.type === 'image_url') {
                        const url = part.image_url.url;
                        const match = url.match(/^data:([^;]+);base64,(.+)$/);
                        if (match) {
                            images.push(match[2]); // Ollama wants just the base64 string
                        }
                    }
                });
                return { role: m.role, content: textContent, images: images.length > 0 ? images : undefined };
            }
            return m;
        });
    };

    // Translates standard predict schema to Ollama's specific /api/chat schema
    const buildPayload = ({ prompt, systemPrompt, maxTokens, temperature, schema, messages, stream }, requestedModel = 'auto') => {
        const payload = {
            model: getModelOrThrow(requestedModel),
            messages: formatMessages(messages, prompt, systemPrompt),
            stream: stream || false,
            options: {}
        };
        
        if (maxTokens) payload.options.num_predict = maxTokens;
        if (typeof temperature === 'number') payload.options.temperature = temperature;
        if (schema && defaultCapabilities.structuredOutput) payload.format = schema;

        return payload;
    };

    return {
        ...base,

        async resolveModel(requestedModel) {
            return requestedModel === 'auto' || !requestedModel ? config.model : requestedModel;
        },

        async listModels() {
            const res = await request(`${apiEndpoint}/api/tags`);
            const json = await res.json();
            
            // Patterns to identify embedding models in Ollama
            const embeddingPatterns = ['embed', 'nomic-embed', 'embedding'];
            const imageGenerationPatterns = ['dall-e', 'imagen', 'imagine', 'image', 'veo', 'easel'];
            const ttsPatterns = ['tts', 'text-to-speech', 'speech'];
            const sttPatterns = ['stt', 'whisper', 'asr', 'transcribe', 'speech-to-text'];
            const contextWindow = await this.getContextWindow();
            
            return (json.models || []).map(m => {
                const id = m.name.toLowerCase();
                const isEmbedding = embeddingPatterns.some(p => id.includes(p));
                const isImageGeneration = imageGenerationPatterns.some(p => id.includes(p));
                const isTts = ttsPatterns.some(p => id.includes(p));
                const isStt = sttPatterns.some(p => id.includes(p));
                const isTextChat = !isEmbedding && !isImageGeneration && !isTts && !isStt;
                
                return {
                    id: m.name,
                    object: 'model',
                    owned_by: 'ollama',
                    capabilities: {
                        chat: isTextChat,
                        embeddings: isEmbedding,
                        structuredOutput: isTextChat && defaultCapabilities.structuredOutput,
                        streaming: isTextChat && defaultCapabilities.streaming,
                        vision: isTextChat && defaultCapabilities.vision,
                        imageGeneration: isImageGeneration,
                        tts: isTts,
                        stt: isStt,
                        context_window: contextWindow
                    }
                };
            });
        },

        async predict(opts, requestedModel = 'auto') {
            const payload = buildPayload(opts, requestedModel);
            const res = await request(`${apiEndpoint}/api/chat`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            // Transform payload responses back into OpenAI compatible standard
            return {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: payload.model,
                provider: config.providerName || 'ollama',
                choices: [{
                    index: 0,
                    message: data.message || { role: "assistant", content: "" },
                    finish_reason: data.done_reason || "stop"
                }],
                usage: {
                    prompt_tokens: data.prompt_eval_count || 0,
                    completion_tokens: data.eval_count || 0,
                    total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
                }
            };
        },

        async *streamComplete(opts, requestedModel = 'auto') {
            const payload = buildPayload({ ...opts, stream: true }, requestedModel);
            const res = await request(`${apiEndpoint}/api/chat`, {
                method: 'POST',
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
                    buffer = lines.pop(); // remainders

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        
                        let data;
                        try {
                             data = JSON.parse(trimmed);
                        } catch(e) {
                             continue;
                        }
             
                        // Map internal streaming data to OpenAI streaming standard payload chunk        
                        const chunk = {
                            id: processId,
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: payload.model,
                            choices: [{
                                index: 0,
                                delta: data.message || {},
                                finish_reason: data.done ? (data.done_reason || "stop") : null
                            }]
                        };

                        if (data.done) {
                            chunk.usage = { /* omit exact mapping to prevent bulk block length issues */ };
                        }

                        yield chunk;
                        if (data.done) return;
                    }
                }
            } finally {
                reader.releaseLock();
            }
        },

        async embedText(input, requestedModel) {
            const model = requestedModel || config.embeddingModel || config.model;
            // Native Ollama endpoint handles only 1 string mapping at a time out of the box unless /api/embeddings is available on new builds. Loop batched wrapper standard:
            const texts = Array.isArray(input) ? input : [input];
            
            const results = [];
            let totalPromptTokens = 0;

            for (let i = 0; i < texts.length; i++) {
                const payload = { model, prompt: texts[i] };
                const res = await request(`${apiEndpoint}/api/embeddings`, {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                
                results.push({
                    object: "embedding",
                    embedding: data.embedding,
                    index: i
                });
                totalPromptTokens += (data.prompt_eval_count || 0); // Not always reliably provided
            }

            return {
                object: "list",
                data: results,
                model: model,
                usage: { prompt_tokens: totalPromptTokens, total_tokens: totalPromptTokens }
            };
        },

        async getContextWindow() {
            // Try to get context window from Ollama API
            const model = config.model;
            if (!model) {
                return config.contextWindow || 8192;
            }
            
            try {
                const res = await request(`${apiEndpoint}/api/show`, {
                    method: 'POST',
                    body: JSON.stringify({ name: model })
                });
                const data = await res.json();
                
                // Ollama returns context_length in the model info
                const contextLength = data.model_info?.['context_length'] || 
                                     data.parameters?.['num_ctx'] ||
                                     config.contextWindow || 
                                     8192;
                return contextLength;
            } catch (err) {
                // Fall back to config or default
                return config.contextWindow || 8192;
            }
        }
    };
}
