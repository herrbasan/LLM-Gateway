import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

export function createOpenAIAdapter(config) {
    const defaultCapabilities = {
        embeddings: !!config.embeddingModel,
        structuredOutput: true,
        streaming: true,
        vision: true,
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
            let json = { data: [] };
            try {
                const res = await request(`${apiEndpoint}/models`, {
                    headers: buildHeaders()
                });
                json = await res.json();
            } catch (err) {
                console.warn(`[OpenAI Adapter '${config.providerName || config.type}'] Failed to fetch models: ${err.message}. Using static fallbacks.`);
            }

            // Patterns to identify capability by model id
            const embeddingPatterns = ['embed', 'embedding'];
            const moderationPatterns = ['moderation'];

            const contextWindow = await this.getContextWindow();

            let modelsList = json.data || [];
            
            // Inject provider-specific fallback models if API returns empty
            if (config.providerName === 'qwen') {
                if (modelsList.length === 0) {
                    modelsList.push({ id: 'qwen-turbo' }, { id: 'qwen-plus' }, { id: 'qwen-max' });
                }
            } else if (config.providerName === 'glm') {
                if (modelsList.length === 0) {
                    modelsList.push({ id: 'glm-4-plus' }, { id: 'glm-4v-plus' }, { id: 'glm-4-flash' });
                }
            } else if (config.providerName === 'grok') {
                if (modelsList.length === 0) {
                    modelsList.push(
                        { id: 'grok-3' },
                        { id: 'grok-3-mini' },
                        { id: 'grok-4-fast-non-reasoning' }
                    );
                }
            } else if (config.providerName === 'openai') {
                if (modelsList.length === 0) {
                    modelsList.push({ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'o1-preview' }, { id: 'o1-mini' });
                }
            }

            return modelsList
                .filter(m => {
                    const id = m.id.toLowerCase();
                    return !moderationPatterns.some(pattern => id.includes(pattern));
                })
                .map(m => {
                    const id = m.id.toLowerCase();
                    const isEmbedding = embeddingPatterns.some(p => id.includes(p));
                    const isTextChat = !isEmbedding;
                    
                    return {
                        id: m.id,
                        object: 'model',
                        owned_by: config.type || 'openai',
                        capabilities: {
                            chat: isTextChat,
                            embeddings: isEmbedding,
                            structuredOutput: isTextChat && defaultCapabilities.structuredOutput,
                            streaming: isTextChat && defaultCapabilities.streaming,
                            vision: isTextChat && defaultCapabilities.vision,
                            context_window: contextWindow
                        }
                    };
                });
        },

        async predict(opts, requestedModel = 'auto') {
            const payload = buildPayload(opts, requestedModel);
            const res = await request(`${apiEndpoint}/chat/completions`, {   
                method: 'POST',
                headers: buildHeaders(),
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            data.provider = config.providerName || config.type || 'openai';
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
        },

        async getContextWindow(requestedModel) {
            // Try to get context window from API
            const model = requestedModel || config.model;
            if (!model) {
                return config.contextWindow || 8192;
            }
            
            try {
                // Try to fetch model info from API
                const res = await request(`${apiEndpoint}/models/${model}`, {
                    headers: buildHeaders()
                });
                
                if (res.ok) {
                    const data = await res.json();
                    // OpenAI returns context_window in the model object
                    if (data.context_window) {
                        return data.context_window;
                    }
                }
            } catch (err) {
                // API might not support model info or model doesn't exist
                console.log(`[OpenAI Adapter] Could not fetch model info for ${model}: ${err.message}`);
            }
            
            // Fall back to config or default
            return config.contextWindow || 8192;
        }
    };
}
