import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

export function createGeminiAdapter(config) {
    const defaultCapabilities = {
        embeddings: true,
        structuredOutput: true,
        streaming: true,
        vision: true,
        ...config.capabilities
    };

    const base = createBaseAdapter('gemini', config, defaultCapabilities);
    const apiKey = config.apiKey;
    const endpoint = config.endpoint;
    const embeddingModel = config.embeddingModel;

    if (!apiKey) {
        throw new Error('Gemini adapter requires an apiKey configuration variable.');
    }
    if (!endpoint) {
        throw new Error('Gemini adapter requires an endpoint configuration variable.');
    }
    if (!config.model) {
        throw new Error('Gemini adapter requires a model configuration variable.');
    }

    const getModelOrThrow = (requestedModel) => {
        const model = requestedModel === 'auto' ? config.model : requestedModel;
        if (!model) throw new Error("Gemini adapter requires a model name.");
        return model;
    };

    // Convert standard OpenAI roles to Gemini native format
    // Assistant -> model, System -> system_instruction.
    const extractSystemInstructions = (messages) => {
        const sysMsgIndex = messages.findIndex(m => m.role === 'system');
        if (sysMsgIndex === -1) return null;
        
        const sysContent = messages[sysMsgIndex].content;
        const filteredMessages = messages.filter((_, i) => i !== sysMsgIndex);
        return { filteredMessages, systemInstruction: sysContent };
    };

    const buildMappedMessages = (messages) => {
        return messages.map(m => {
            let parts = [];
            if (Array.isArray(m.content)) {
                parts = m.content.map(part => {
                    if (part.type === 'text') return { text: part.text };
                    if (part.type === 'image_url') {
                        // Assuming data URI: data:image/png;base64,....
                        const url = part.image_url.url;
                        const match = url.match(/^data:([^;]+);base64,(.+)$/);
                        if (match) {
                            console.log(`[Gemini Adapter] Processing inline image: mimeType=${match[1]}, size=${match[2].length} chars`);
                            return {
                                inlineData: {
                                    mimeType: match[1],
                                    data: match[2]
                                }
                            };
                        }
                        // If not base64, log a warning - router should have converted it
                        console.warn(`[Gemini Adapter] Received non-data URL (router may not have processed): ${url.substring(0, 50)}...`);
                        return { text: "[System Placeholder: Image Omitted - Remote URLs not supported]" };
                    }
                    return null;
                }).filter(Boolean);
            } else {
                parts = [{ text: String(m.content || '') }];
            }

            return {
                role: m.role === 'assistant' ? 'model' : 'user', // Maps `system` out prior normally
                parts
            };
        });
    };

    const buildPayload = ({ prompt, systemPrompt, maxTokens, temperature, schema, messages }) => {
        const rawMessages = messages && Array.isArray(messages) ? messages : [];
        if (!messages) {
            if (prompt) rawMessages.push({ role: 'user', content: prompt });
        }

        const sysExtraction = extractSystemInstructions(rawMessages);
        const activeMessages = sysExtraction && sysExtraction.filteredMessages ? sysExtraction.filteredMessages : rawMessages;
        let finalSysPrompt = systemPrompt;
        if (sysExtraction && sysExtraction.systemInstruction) {
             finalSysPrompt = sysExtraction.systemInstruction;
        }

        const payload = {
            contents: buildMappedMessages(activeMessages),
            generationConfig: {
                 // Empty but cleanly initiable
            }
        };

        if (finalSysPrompt) {
            payload.system_instruction = { parts: [{ text: finalSysPrompt }] };
        }
        
        if (maxTokens) payload.generationConfig.maxOutputTokens = maxTokens;
        if (typeof temperature === 'number') payload.generationConfig.temperature = temperature;

        if (schema && defaultCapabilities.structuredOutput) {
            payload.generationConfig.responseMimeType = "application/json";
            payload.generationConfig.responseSchema = schema; // Requires Google natively supported dialect format
        }

        return payload;
    };

    return {
        ...base,

        async resolveModel(requestedModel) {
            return requestedModel === 'auto' || !requestedModel ? config.model : requestedModel;
        },

        async listModels() {
            let json = { models: [] };
            try {
                const modelRes = await request(`${endpoint}/models?key=${apiKey}`);
                json = await modelRes.json();
            } catch (err) {
                console.warn(`[Gemini Adapter] Failed to fetch models: ${err.message}. Using static fallbacks.`);
            }

            // Patterns to identify model capabilities
            const embeddingPatterns = ['embedding', 'embed'];
            const excludedPatterns = ['computer-use', 'deep-research', 'robotics'];
            const contextWindow = await this.getContextWindow();

            let modelsList = json.models || [];
            
            // Inject static fallbacks if API missing
            if (modelsList.length === 0) {
                modelsList.push(
                    { name: 'models/gemini-2.0-flash' },
                    { name: 'models/gemini-2.5-flash' },
                    { name: 'models/gemini-1.5-pro' }
                );
            }

            return modelsList
                .filter(m => {
                    const id = m.name.replace('models/', '').toLowerCase();
                    return !excludedPatterns.some(pattern => id.includes(pattern));
                })
                .map(m => {
                    const id = m.name.replace('models/', '').toLowerCase();
                    const isEmbedding = embeddingPatterns.some(p => id.includes(p));
                    const isTextChat = !isEmbedding;
                    
                    return {
                        id: m.name.replace('models/', ''),
                        object: 'model',
                        owned_by: 'google',
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

        async countTokens(text, requestedModel = 'auto') {
            const model = getModelOrThrow(requestedModel);
            try {
                const res = await request(`${endpoint}/models/${model}:countTokens?key=${apiKey}`, {
                    method: 'POST',
                    body: JSON.stringify({
                        contents: [{
                            role: 'user',
                            parts: [{ text }]
                        }]
                    })
                });
                const data = await res.json();
                if (data.error) return null;
                return Math.ceil(data.totalTokens || 0);
            } catch (err) {
                return null;
            }
        },

        async predict(opts, requestedModel = 'auto') {
            const model = getModelOrThrow(requestedModel);
            const payload = buildPayload(opts);

            const res = await request(`${endpoint}/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (data.error) {
                const err = new Error(`Gemini API Error: ${data.error.message}`);
                err.status = data.error.code;
                throw err;
            }

            // Return transformed
            const outText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
            return {
                id: `gemini-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
                provider: "gemini",
                choices: [{
                    index: 0,
                    message: { role: "assistant", content: outText },
                    finish_reason: data.candidates?.[0]?.finishReason === "STOP" ? "stop" : data.candidates?.[0]?.finishReason?.toLowerCase()
                }],
                usage: {
                    prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
                    completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
                    total_tokens: data.usageMetadata?.totalTokenCount || 0
                }
            };
        },

        async *streamComplete(opts, requestedModel = 'auto') {
            const model = getModelOrThrow(requestedModel);
            const payload = buildPayload(opts);

            const res = await request(`${endpoint}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const processId = `gemini-${Date.now()}`;
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
                        if (!trimmed || !trimmed.startsWith('data: ')) continue;
                        
                        let dataStr = trimmed.slice(6);
                        if (dataStr === '[DONE]') return;

                        let payloadData;
                        try {
                             payloadData = JSON.parse(dataStr);
                        } catch(e) {
                             continue;
                        }

                        if (!payloadData.candidates || !payloadData.candidates[0]) continue;
                        
                        const textChunk = payloadData.candidates[0].content?.parts?.[0]?.text || '';

                        const chunk = {
                            id: processId,
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: model,
                            choices: [{
                                index: 0,
                                delta: { content: textChunk },
                                finish_reason: payloadData.candidates[0].finishReason === "STOP" ? "stop" : null
                            }]
                        };

                        yield chunk;
                    }
                }
            } finally {
                reader.releaseLock();
            }
        },
        
        async embedText(input, requestedModel) {
            const model = requestedModel || embeddingModel;
            if (!model) {
                throw new Error('Gemini adapter requires an embeddingModel for embeddings');
            }
            const texts = Array.isArray(input) ? input : [input];
            
            // Build batch-specific requests inside one REST call utilizing `batchEmbedContents`
            const requests = texts.map(text => ({
                model: `models/${model}`,
                content: { parts: [{ text }] }
            }));

            const res = await request(`${endpoint}/models/${model}:batchEmbedContents?key=${apiKey}`, {
                method: 'POST',
                body: JSON.stringify({ requests })
            });
            const data = await res.json();

            if (data.error) {
                 throw new Error(`Gemini Embedding Error: ${data.error.message}`);
            }

            return {
                object: "list",
                data: (data.embeddings || []).map((emb, index) => ({
                    object: "embedding",
                    embedding: emb.values,
                    index
                })),
                model: model,
                usage: {} // Gemini does not accurately give token bounds outside completion responses out of the box currently.
            };
        },

        async getContextWindow(requestedModel) {
            // Try to get context window from Gemini API
            const model = requestedModel || config.model;
            if (!model) {
                return config.contextWindow || 8192;
            }
            
            try {
                // Gemini returns model info including inputTokenLimit
                const res = await request(`${endpoint}/models/${model}?key=${apiKey}`);
                
                if (res.ok) {
                    const data = await res.json();
                    // Gemini uses inputTokenLimit for context window
                    if (data.inputTokenLimit) {
                        return data.inputTokenLimit;
                    }
                }
            } catch (err) {
                console.log(`[Gemini Adapter] Could not fetch model info for ${model}: ${err.message}`);
            }
            
            // Fall back to config or default
            return config.contextWindow || 8192;
        }
    };
}
