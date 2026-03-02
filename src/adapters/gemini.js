import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

export function createGeminiAdapter(config) {
    const defaultCapabilities = {
        embeddings: true,
        structuredOutput: true,
        streaming: true,
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
        return messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user', // Maps `system` out prior normally
            parts: [{ text: m.content }]
        }));
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
            const modelRes = await request(`${endpoint}/models?key=${apiKey}`);
            const json = await modelRes.json();
            return (json.models || []).map(m => ({
                id: m.name.replace('models/', ''),
                object: 'model',
                owned_by: 'gemini',
                capabilities: defaultCapabilities
            }));
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
        }
    };
}
