import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

export function createOllamaAdapter(config) {
    const defaultCapabilities = {
        embeddings: true,
        structuredOutput: true,
        streaming: true,
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
        if (messages && Array.isArray(messages)) return messages;
        const out = [];
        if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
        if (prompt) out.push({ role: 'user', content: prompt });
        return out;
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
            return (json.models || []).map(m => ({
                id: m.name,
                object: 'model',
                owned_by: 'ollama',
                capabilities: defaultCapabilities
            }));
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
                provider: "ollama",
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
        }
    };
}
