import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

export function createLmStudioAdapter(config) {
    const defaultCapabilities = {
        embeddings: true,
        structuredOutput: true,
        streaming: true,
        ...config.capabilities
    };

    const base = createBaseAdapter('lmstudio', config, defaultCapabilities);
    const apiEndpoint = config.endpoint;
    if (!apiEndpoint) {
        throw new Error('LM Studio adapter requires an endpoint');
    }

    const getModelOrThrow = (requestedModel) => {
        const model = requestedModel === 'auto' ? config.model : requestedModel;
        if (!model) throw new Error("LM Studio adapter requires a model name.");
        return model;
    };

    // Formats independent messages from prompt vs standalone prompt arrays
    const formatMessages = (messages, prompt, systemPrompt) => {
        if (messages && Array.isArray(messages)) return messages;
        const out = [];
        if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
        if (prompt) out.push({ role: 'user', content: prompt });
        return out;
    };

    const buildPayload = ({ prompt, systemPrompt, maxTokens, temperature, schema, messages, stream }, requestedModel = 'auto') => {
        const payload = {
            model: getModelOrThrow(requestedModel),
            messages: formatMessages(messages, prompt, systemPrompt),
            stream: stream || false
        };

        if (maxTokens) payload.max_tokens = maxTokens;
        if (typeof temperature === 'number') payload.temperature = temperature;
        if (schema && defaultCapabilities.structuredOutput) {
            payload.response_format = {
                type: "json_schema",
                json_schema: { name: "response", strict: true, schema }
            };
        }
        return payload;
    };

    return {
        ...base,

        async resolveModel(requestedModel) {
            // "auto" falls back to pre-configured adapter default
            return requestedModel === 'auto' || !requestedModel ? config.model : requestedModel;
        },

        async listModels() {
            const res = await request(`${apiEndpoint}/v1/models`);
            const json = await res.json();
            return json.data.map(m => ({
                id: m.id,
                object: 'model',
                owned_by: 'lmstudio',
                capabilities: defaultCapabilities
            }));
        },

        async predict(opts, requestedModel = 'auto') {
            const payload = buildPayload(opts, requestedModel);
            const res = await request(`${apiEndpoint}/v1/chat/completions`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            data.provider = 'lmstudio';
            return data;
        },

        async *streamComplete(opts, requestedModel = 'auto') {
            const payload = buildPayload({ ...opts, stream: true }, requestedModel);
            const res = await request(`${apiEndpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Accept': 'text/event-stream' },
                body: JSON.stringify(payload)
            });

            // Native fetch streaming
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // keep remainder

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(':')) continue; // Skip comments/empty
                        
                        if (trimmed.startsWith('data: ')) {
                            const data = trimmed.slice(6);
                            if (data === '[DONE]') return;
                            try {
                                const parsed = JSON.parse(data);
                                parsed.provider = 'lmstudio';
                                yield parsed;
                            } catch(e) {
                                // Ignore broken json frames inside a streaming loop
                            }
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }
        },

        async embedText(input, requestedModel) {
             const model = requestedModel || config.embeddingModel;
             const payload = {
                 input: Array.isArray(input) ? input : [input],
                 model: model
             };
             const res = await request(`${apiEndpoint}/v1/embeddings`, {
                 method: 'POST',
                 body: JSON.stringify(payload)
             });
             return await res.json();
        }
    };
}
