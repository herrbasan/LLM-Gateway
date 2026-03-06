import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

export function createLmStudioAdapter(config) {
    const defaultCapabilities = {
        embeddings: true,
        structuredOutput: true,
        streaming: true,
        vision: false,
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
            // Try the internal LM Studio API first (has accurate capability metadata)
            let models = [];
            try {
                const res = await request(`${apiEndpoint}/api/v1/models`);
                const json = await res.json();
                
                if (json.models && Array.isArray(json.models)) {
                    return json.models.map(m => {
                        const caps = m.capabilities || {};
                        const isEmbedding = m.type === 'embedding';
                        const isTextChat = m.type === 'llm';
                        
                        return {
                            id: m.key || m.id,
                            object: 'model',
                            owned_by: m.publisher || 'lmstudio',
                            capabilities: {
                                chat: isTextChat,
                                embeddings: isEmbedding,
                                structuredOutput: isTextChat && defaultCapabilities.structuredOutput,
                                streaming: isTextChat && defaultCapabilities.streaming,
                                vision: caps.vision === true,
                                imageGeneration: false, // LM Studio doesn't do image generation
                                tts: false,
                                stt: false,
                                context_window: m.max_context_length || await this.getContextWindow()
                            }
                        };
                    });
                }
            } catch (err) {
                console.warn('[LMStudio Adapter] Internal API failed, falling back to OpenAI-compatible endpoint:', err.message);
            }
            
            // Fallback to OpenAI-compatible /v1/models endpoint
            const res = await request(`${apiEndpoint}/v1/models`);
            const json = await res.json();
            
            // Patterns to identify model capabilities by name
            const embeddingPatterns = ['embed', 'embedding'];
            const visionPatterns = [
                'vision', '-v', 'vl', '4v', '4.6v', 'gpt-4o', 'gemini', 'claude-3', 
                'llava', 'bakllava', 'moondream', 'moonlight',
                'qwen2.5-vl', 'qwen-vl', 'qwen3-vl', 'glm-4v', 'glm-4.6v', 'cogvlm',
                'gemma-3'
            ];
            
            const contextWindow = await this.getContextWindow();
            
            return json.data.map(m => {
                const id = m.id.toLowerCase();
                const isEmbedding = embeddingPatterns.some(p => id.includes(p));
                const isTextChat = !isEmbedding;
                const isVision = isTextChat && visionPatterns.some(p => id.includes(p));
                
                return {
                    id: m.id,
                    object: 'model',
                    owned_by: 'lmstudio',
                    capabilities: {
                        chat: isTextChat,
                        embeddings: isEmbedding,
                        structuredOutput: isTextChat && defaultCapabilities.structuredOutput,
                        streaming: isTextChat && defaultCapabilities.streaming,
                        vision: isVision,
                        imageGeneration: false,
                        tts: false,
                        stt: false,
                        context_window: contextWindow
                    }
                };
            });
        },

        async predict(opts, requestedModel = 'auto') {
            const payload = buildPayload(opts, requestedModel);
            const res = await request(`${apiEndpoint}/v1/chat/completions`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            data.provider = config.providerName || 'lmstudio';
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
        },

        async getContextWindow(requestedModel) {
            // Try to get context window from LM Studio API
            const model = requestedModel || config.model;
            if (!model) {
                return config.contextWindow || 8192;
            }
            
            try {
                // Try to fetch all models and find the matching one
                const res = await request(`${apiEndpoint}/v1/models`);
                
                if (res.ok) {
                    const data = await res.json();
                    console.log(`[LM Studio Adapter] Models response:`, JSON.stringify(data, null, 2));
                    
                    const modelInfo = data.data?.find(m => m.id === model);
                    console.log(`[LM Studio Adapter] Found model info for ${model}:`, modelInfo);
                    
                    // Check various possible field names for context window
                    const ctxWindow = modelInfo?.context_window || 
                                     modelInfo?.max_context || 
                                     modelInfo?.contextWindow ||
                                     modelInfo?.n_ctx ||
                                     modelInfo?.max_model_len ||
                                     modelInfo?.max_sequence_length;
                    
                    if (ctxWindow) {
                        console.log(`[LM Studio Adapter] Using context window from API: ${ctxWindow}`);
                        return ctxWindow;
                    }
                }
            } catch (err) {
                // API might not be available
                console.log(`[LM Studio Adapter] Could not fetch model list: ${err.message}`);
            }
            
            // Fall back to config or default
            console.log(`[LM Studio Adapter] Falling back to config context window: ${config.contextWindow || 8192}`);
            return config.contextWindow || 8192;
        }
    };
}
