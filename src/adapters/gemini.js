/**
 * Gemini Adapter - Protocol handler for Google Gemini API.
 * Stateless - model config passed per-request.
 */

import { request as httpRequest } from '../utils/http.js';

/**
 * Creates a Gemini adapter instance.
 * No config needed at factory time - pure protocol handler.
 */
export function createGeminiAdapter() {
    return {
        name: 'gemini',

        /**
         * Chat completion.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Standardized request
         */
        async chatComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'gemini-pro';

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required in modelConfig');
            }

            const payload = buildChatPayload(request, capabilities);

            const res = await httpRequest(`${endpoint}/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (data.error) {
                const err = new Error(`Gemini API Error: ${data.error.message}`);
                err.status = data.error.code;
                throw err;
            }

            const outText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

            return {
                id: `gemini-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: model,
                provider: 'gemini',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: outText },
                    finish_reason: data.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : data.candidates?.[0]?.finishReason?.toLowerCase()
                }],
                usage: {
                    prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
                    completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
                    total_tokens: data.usageMetadata?.totalTokenCount || 0
                }
            };
        },

        /**
         * Streaming chat completion.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Standardized request
         */
        async *streamComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'gemini-pro';

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required in modelConfig');
            }

            const payload = buildChatPayload(request, capabilities);

            const res = await httpRequest(`${endpoint}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`, {
                method: 'POST',
                signal: request.signal,
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

                        const dataStr = trimmed.slice(6);
                        if (dataStr === '[DONE]') return;

                        let payloadData;
                        try {
                            payloadData = JSON.parse(dataStr);
                        } catch (e) {
                            continue;
                        }

                        if (!payloadData.candidates || !payloadData.candidates[0]) continue;

                        const textChunk = payloadData.candidates[0].content?.parts?.[0]?.text || '';

                        const chunk = {
                            id: processId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: model,
                            provider: 'gemini',
                            choices: [{
                                index: 0,
                                delta: { content: textChunk },
                                finish_reason: payloadData.candidates[0].finishReason === 'STOP' ? 'stop' : null
                            }]
                        };

                        if (payloadData.usageMetadata) {
                            chunk.usage = {
                                prompt_tokens: payloadData.usageMetadata.promptTokenCount || 0,
                                completion_tokens: payloadData.usageMetadata.candidatesTokenCount || 0,
                                total_tokens: payloadData.usageMetadata.totalTokenCount || 0
                            };
                        }

                        yield chunk;
                    }
                }
            } finally {
                reader.releaseLock();
            }
        },

        /**
         * Create embeddings.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Standardized request
         */
        async createEmbedding(modelConfig, request) {
            const { endpoint, apiKey, adapterModel } = modelConfig;
            const model = adapterModel || 'embedding-001';

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required in modelConfig');
            }

            const input = Array.isArray(request.input) ? request.input : [request.input];

            const requests = input.map(text => ({
                model: `models/${model}`,
                content: { parts: [{ text }] }
            }));

            const res = await httpRequest(`${endpoint}/models/${model}:batchEmbedContents?key=${apiKey}`, {
                method: 'POST',
                body: JSON.stringify({ requests })
            });

            const data = await res.json();

            if (data.error) {
                throw new Error(`Gemini Embedding Error: ${data.error.message}`);
            }

            return {
                object: 'list',
                data: (data.embeddings || []).map((emb, index) => ({
                    object: 'embedding',
                    embedding: emb.values,
                    index
                })),
                model: model,
                usage: {}
            };
        },

        /**
         * Generate image using Imagen models.
         */
        async generateImage(modelConfig, request) {
            const { endpoint, apiKey, adapterModel } = modelConfig;
            const model = adapterModel || 'imagen-4.0-generate-001';

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required for image generation');
            }

            const payload = {
                instances: [{ prompt: request.prompt }],
                parameters: {
                    sampleCount: request.n || 1,
                    aspectRatio: request.size ? mapSizeToAspectRatio(request.size) : '1:1'
                }
            };

            const res = await httpRequest(`${endpoint}/models/${model}:predict?key=${apiKey}`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            
            if (data.error) {
                throw new Error(`Gemini Imagen Error: ${data.error.message}`);
            }

            // Extract base64 encoded images from response
            // Imagen returns predictions array with bytesBase64Encoded field
            const predictions = data.predictions || [];
            const images = predictions.map((pred, index) => {
                const b64 = pred.bytesBase64Encoded || pred.base64Encoded || pred.base64;
                if (!b64) {
                    console.warn('[GeminiAdapter] No base64 data in prediction:', Object.keys(pred));
                }
                return {
                    b64_json: b64,
                    index: index
                };
            }).filter(img => img.b64_json);

            if (images.length === 0) {
                throw new Error('[GeminiAdapter] No image data returned from Imagen');
            }

            return {
                created: Math.floor(Date.now() / 1000),
                data: images
            };
        },

        /**
         * Synthesize speech (Gemini 2.0+ supports this).
         */
        async synthesizeSpeech(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            
            if (!capabilities?.tts) {
                throw new Error('[GeminiAdapter] TTS not enabled for this model');
            }

            const model = adapterModel || 'gemini-2.0-flash-exp';

            const payload = {
                contents: [{
                    role: 'user',
                    parts: [{ text: request.input }]
                }],
                generationConfig: {
                    responseModalities: ['AUDIO']
                }
            };

            const res = await httpRequest(`${endpoint}/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (data.error) {
                throw new Error(`Gemini TTS Error: ${data.error.message}`);
            }

            // Extract audio data from response
            const audioPart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith('audio/'));
            
            if (!audioPart) {
                throw new Error('[GeminiAdapter] No audio data in response');
            }

            return {
                audio: audioPart.inlineData.data,
                mimeType: audioPart.inlineData.mimeType
            };
        },

        /**
         * Generate video using Veo models.
         */
        async generateVideo(modelConfig, request) {
            const { endpoint, apiKey, adapterModel } = modelConfig;
            const model = adapterModel || 'veo-3.1-generate-preview';

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required for video generation');
            }

            const payload = {
                instances: [{
                    prompt: request.prompt
                }],
                parameters: {
                    aspectRatio: request.size ? mapSizeToAspectRatio(request.size) : '16:9',
                    durationSeconds: request.duration || 8
                }
            };

            // Add image if provided (for image-to-video)
            if (request.image) {
                payload.instances[0].image = {
                    bytesBase64Encoded: request.image.b64_json || request.image
                };
            }

            const res = await httpRequest(`${endpoint}/models/${model}:predict?key=${apiKey}`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (data.error) {
                throw new Error(`Gemini Veo Error: ${data.error.message}`);
            }

            // Veo returns an operation that needs polling
            const operation = data.name;
            if (!operation) {
                throw new Error('[GeminiAdapter] No operation returned from Veo');
            }

            return {
                operation: operation,
                status: 'pending',
                created: Math.floor(Date.now() / 1000)
            };
        },

        /**
         * List available models.
         * @param {Object} modelConfig - Model configuration (for API key/endpoint)
         */
        async listModels(modelConfig) {
            const { endpoint, apiKey } = modelConfig;

            if (!apiKey) {
                throw new Error('[GeminiAdapter] apiKey is required in modelConfig');
            }

            const res = await httpRequest(`${endpoint}/models?key=${apiKey}`);
            const data = await res.json();

            if (!data.models || !Array.isArray(data.models)) {
                throw new Error('[GeminiAdapter] Invalid response from API');
            }

            return data.models
                .filter(m => {
                    const id = m.name.replace('models/', '').toLowerCase();
                    // Exclude non-API models
                    return !['computer-use', 'deep-research', 'robotics'].some(p => id.includes(p));
                })
                .map(m => {
                    const id = m.name.replace('models/', '');
                    const idLower = id.toLowerCase();
                    const isEmbedding = idLower.includes('embedding') || idLower.includes('embed');
                    const isVision = !isEmbedding && !idLower.includes('aqa');

                    return {
                        id,
                        object: 'model',
                        owned_by: 'google',
                        capabilities: {
                            chat: !isEmbedding,
                            embeddings: isEmbedding,
                            structuredOutput: !isEmbedding,
                            streaming: !isEmbedding,
                            vision: isVision
                        }
                    };
                });
        }
    };
}

/**
 * Map OpenAI-style size strings to Imagen aspect ratios.
 * @param {string} size - Size string like "1024x1024", "1024x1536", etc.
 * @returns {string} Imagen aspect ratio like "1:1", "2:3", etc.
 */
function mapSizeToAspectRatio(size) {
    const [width, height] = size.split('x').map(Number);
    if (!width || !height) return '1:1';
    
    const ratio = width / height;
    if (Math.abs(ratio - 1) < 0.1) return '1:1';
    if (Math.abs(ratio - 0.75) < 0.1) return '3:4';
    if (Math.abs(ratio - 1.33) < 0.1) return '4:3';
    if (Math.abs(ratio - 0.67) < 0.1) return '2:3';
    if (Math.abs(ratio - 1.5) < 0.1) return '3:2';
    if (Math.abs(ratio - 0.56) < 0.1) return '9:16';
    if (Math.abs(ratio - 1.78) < 0.1) return '16:9';
    
    return '1:1'; // Default
}

// Helper functions

function buildChatPayload(request, capabilities) {
    const messages = request.messages || [];
    const systemMsg = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const payload = {
        contents: otherMessages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: buildMessageParts(m)
        })),
        generationConfig: {}
    };

    if (systemMsg) {
        payload.system_instruction = {
            parts: [{ text: String(systemMsg.content) }]
        };
    }

    if (request.maxTokens) {
        payload.generationConfig.maxOutputTokens = request.maxTokens;
    }

    if (typeof request.temperature === 'number') {
        payload.generationConfig.temperature = request.temperature;
    }

    if (request.schema && capabilities?.structuredOutput) {
        payload.generationConfig.responseMimeType = 'application/json';
        payload.generationConfig.responseSchema = request.schema;
    }

    return payload;
}

function buildMessageParts(message) {
    if (Array.isArray(message.content)) {
        return message.content.map(part => {
            if (part.type === 'text') {
                return { text: part.text };
            }
            if (part.type === 'image_url') {
                const url = part.image_url?.url || '';
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                    return {
                        inlineData: {
                            mimeType: match[1],
                            data: match[2]
                        }
                    };
                }
                return { text: '[Image: remote URL not supported]' };
            }
            return { text: String(part) };
        }).filter(Boolean);
    }

    return [{ text: String(message.content || '') }];
}
