import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

export function createOpenAIAdapter(config) {
    const defaultCapabilities = {
        embeddings: !!config.embeddingModel,
        structuredOutput: true,
        streaming: true,
        ...config.capabilities
    };

    const base = createBaseAdapter(config.type || 'openai', config, defaultCapabilities);    
    const apiEndpoint = config.endpoint;
    if (!apiEndpoint) {
        throw new Error('OpenAI adapter requires an endpoint');
    }
    
    // Most OpenAI compat proxies use apiKey. 
    // Defaults here to provide generic passthrough support for Grok, Kimi, GLM, etc
    const apiKey = config.apiKey;

    const getModelOrThrow = (requestedModel) => {
        const model = requestedModel === 'auto' ? config.model : requestedModel;
        if (!model) throw new Error(`${config.type || 'OpenAI'} adapter requires a model name.`);
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

    const buildHeaders = (customHeaders = {}) => {
        const headers = { ...customHeaders };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        return headers;
    };

    return {
        ...base,

        async resolveModel(requestedModel) {
            // "auto" falls back to pre-configured adapter default
            return requestedModel === 'auto' || !requestedModel ? config.model : requestedModel;
        },

        async listModels() {
            const res = await request(`${apiEndpoint}/models`, {
                headers: buildHeaders()
            });
            const json = await res.json();
            return (json.data || []).map(m => ({
                id: m.id,
                object: 'model',
                owned_by: config.type || 'openai',
                capabilities: defaultCapabilities
            }));
        },

        async predict(opts, requestedModel = 'auto') {
            const payload = buildPayload(opts, requestedModel);
            const res = await request(`${apiEndpoint}/chat/completions`, {   
                method: 'POST',
                headers: buildHeaders(),
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            data.provider = config.type || 'openai';
            return data; // Return full standard OpenAI response cleanly        
        },

        async *streamComplete(opts, requestedModel = 'auto') {
            const payload = buildPayload({ ...opts, stream: true }, requestedModel);
            const res = await request(`${apiEndpoint}/chat/completions`, {   
                method: 'POST',
                headers: buildHeaders({ 'Accept': 'text/event-stream' }),
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
                                parsed.provider = config.type || 'openai';
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
            if (!config.embeddingModel && !requestedModel) {
                throw new Error(`${config.type || 'OpenAI'} Embedding Error: No embedding model configured.`);
            }
             const model = requestedModel || config.embeddingModel;
             const payload = {
                 input: Array.isArray(input) ? input : [input],
                 model: model
             };
             const res = await request(`${apiEndpoint}/embeddings`, {        
                 method: 'POST',
                 headers: buildHeaders(),
                 body: JSON.stringify(payload)
             });
             return await res.json();
        }
    };
}
