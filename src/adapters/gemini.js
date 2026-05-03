/**
 * Gemini Adapter - Protocol handler for Google Gemini API.
 * Stateless - model config passed per-request.
 */

import { request as httpRequest } from '../utils/http.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

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

            const candidate = data.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            let outText = '';
            let tool_calls = [];

            parts.forEach(p => {
                if (p.text) outText += p.text;
                if (p.functionCall) {
                    tool_calls.push({
                        id: `call_${Math.random().toString(36).substring(2, 11)}`,
                        type: 'function',
                        function: {
                            name: p.functionCall.name,
                            arguments: JSON.stringify(p.functionCall.args || {})
                        }
                    });
                }
            });

            const message = { role: 'assistant', content: outText || null };
            if (tool_calls.length > 0) message.tool_calls = tool_calls;
            
            let finishReason;
            if (tool_calls.length > 0) {
                finishReason = 'tool_calls';
            } else {
                finishReason = candidate?.finishReason === 'STOP' ? 'stop' : (candidate?.finishReason?.toLowerCase() || 'stop');
            }

            return {
                id: `gemini-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: model,
                provider: 'gemini',
                choices: [{
                    index: 0,
                    message,
                    finish_reason: finishReason || 'stop'
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
            let hasEmittedTools = false;

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

                        const candidate = payloadData.candidates[0];
                        const parts = candidate.content?.parts || [];
                        let outText = '';
                        const toolParts = [];

                        parts.forEach(p => {
                            if (p.text) outText += p.text;
                            if (p.functionCall) toolParts.push(p.functionCall);
                        });

                        const usage = payloadData.usageMetadata ? {
                            prompt_tokens: payloadData.usageMetadata.promptTokenCount || 0,
                            completion_tokens: payloadData.usageMetadata.candidatesTokenCount || 0,
                            total_tokens: payloadData.usageMetadata.totalTokenCount || 0
                        } : undefined;

                        // Emit text Delta (or empty chunk if no text but no tools either)
                        if (outText || toolParts.length === 0) {
                            let finishReason = candidate.finishReason === 'STOP' ? 'stop' : candidate.finishReason?.toLowerCase();
                            if (hasEmittedTools && finishReason === 'stop') {
                                finishReason = 'tool_calls';
                            }
                            
                            // If we already emitted tools in a prior chunk, and this is just an empty 'stop' closure, 
                            // suppress emitting another delta entirely unless it has usage telemetry.
                            if (!outText && toolParts.length === 0 && hasEmittedTools) {
                                if (usage) {
                                    yield {
                                        id: processId,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: model,
                                        provider: 'gemini',
                                        choices: [],
                                        usage: usage
                                    };
                                }
                                continue;
                            }

                            const chunk = {
                                id: processId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: model,
                                provider: 'gemini',
                                choices: [{
                                    index: 0,
                                    delta: { content: outText || null },
                                    finish_reason: (toolParts.length === 0) ? (finishReason || null) : null
                                }]
                            };
                            if (usage) chunk.usage = usage;
                            yield chunk;
                        }

                        // Emit tool Parts strictly as OpenAI expects: id+name first, then arguments
                        if (toolParts.length > 0) {
                            hasEmittedTools = true;
                            let finishReason = candidate.finishReason === 'STOP' ? 'tool_calls' : candidate.finishReason?.toLowerCase();
                            if (!finishReason) finishReason = 'tool_calls';

                            for (let i = 0; i < toolParts.length; i++) {
                                const callId = `call_${Math.random().toString(36).substring(2, 11)}`;
                                const f = toolParts[i];
                                
                                // Chunk 1: Initialize tool call with id, type, name (no arguments)
                                yield {
                                    id: processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: model,
                                    provider: 'gemini',
                                    choices: [{
                                        index: 0,
                                        delta: {
                                            tool_calls: [{
                                                index: i,
                                                id: callId,
                                                type: 'function',
                                                function: { name: f.name, arguments: '' }
                                            }]
                                        },
                                        finish_reason: null
                                    }]
                                };

                                // Chunk 2: Send arguments, attach finish_reason to the last one
                                const chunkArgs = {
                                    id: processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: model,
                                    provider: 'gemini',
                                    choices: [{
                                        index: 0,
                                        delta: {
                                            tool_calls: [{
                                                index: i,
                                                function: { arguments: JSON.stringify(f.args || {}) }
                                            }]
                                        },
                                        finish_reason: (i === toolParts.length - 1) ? finishReason : null
                                    }]
                                };
                                if (usage && i === toolParts.length - 1) chunkArgs.usage = usage;
                                yield chunkArgs;
                            }
                        }
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
                    logger.warn('No base64 data in prediction', { keys: Object.keys(pred) }, 'GeminiAdapter');
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

function buildGeminiTools(openAiTools) {
    if (!openAiTools || !openAiTools.length) return undefined;
    
    const functionDeclarations = openAiTools
        .filter(t => t.type === 'function' && t.function)
        .map(t => {
            const f = t.function;
            const decl = {
                name: f.name,
                description: f.description || ''
            };
            if (f.parameters) {
                decl.parameters = f.parameters;
            }
            return decl;
        });

    return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
}

function buildGeminiToolConfig(toolChoice) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') {
        if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
        if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
        if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
    } else if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
        return {
            functionCallingConfig: {
                mode: 'ANY',
                allowedFunctionNames: [toolChoice.function.name]
            }
        };
    }
    return undefined;
}

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

    if (request.tools) {
        const mappedTools = buildGeminiTools(request.tools);
        if (mappedTools) {
            payload.tools = mappedTools;
        }
    }

    if (request.tool_choice) {
        const mappedToolConfig = buildGeminiToolConfig(request.tool_choice);
        if (mappedToolConfig) {
            payload.toolConfig = mappedToolConfig;
        }
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
    const parts = [];

    if (message.role === 'tool') {
        let responseObj;
        try {
            responseObj = JSON.parse(message.content);
            if (typeof responseObj !== 'object' || responseObj === null) {
                responseObj = { value: responseObj };
            }
        } catch {
            responseObj = { result: String(message.content || '') };
        }
        parts.push({
            functionResponse: {
                name: message.name || 'unknown_tool',
                response: responseObj
            }
        });
        return parts; // tool messages strictly carry functionResponse
    }

    if (message.role === 'assistant' && message.tool_calls) {
        message.tool_calls.forEach(tc => {
            if (tc.type === 'function' && tc.function) {
                let args = {};
                if (tc.function.arguments) {
                    try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                }
                parts.push({
                    functionCall: {
                        name: tc.function.name,
                        args
                    }
                });
            }
        });
    }

    if (Array.isArray(message.content)) {
        message.content.forEach(part => {
            if (part.type === 'text') {
                parts.push({ text: part.text });
            } else if (part.type === 'image_url') {
                const url = part.image_url?.url || '';
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                    parts.push({
                        inlineData: {
                            mimeType: match[1],
                            data: match[2]
                        }
                    });
                } else {
                    parts.push({ text: '[Image: remote URL not supported]' });
                }
            } else {
                parts.push({ text: String(part) });
            }
        });
    } else if (message.content) {
        parts.push({ text: String(message.content) });
    }

    return parts.length > 0 ? parts : [{ text: '' }];
}
