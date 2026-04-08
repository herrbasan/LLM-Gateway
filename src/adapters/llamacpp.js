/**
 * llama.cpp Adapter - Protocol handler for llama.cpp server.
 * Optimized for direct llama.cpp OpenAI-compatible API.
 * 
 * llama.cpp is the fastest and most reliable inference engine for GGUF models.
 * This adapter provides direct integration without abstraction overhead.
 * 
 * Features:
 * - Config-level maxTokens override
 * - Hard token cap for safety (models ignoring max_tokens)
 * - Config-level extraBody for provider-specific parameters
 * - Request-level extra_body support
 */

import { request as httpRequest } from '../utils/http.js';
import { getInferenceManager } from '../core/inference-manager.js';

export function createLlamaCppAdapter() {
    const inferenceManager = getInferenceManager();

    return {
        name: 'llamacpp',

        /**
         * Ensure local inference server is running.
         */
        async ensureServer(modelConfig) {
            if (modelConfig.localInference?.enabled) {
                const modelId = modelConfig.adapterModel || 'llama-local';
                try {
                    await inferenceManager.startServer(modelId, modelConfig);
                } catch (err) {
                    // Server might already be running
                    if (!err.message.includes('already running')) {
                        throw err;
                    }
                }
            }
        },

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            await this.ensureServer(modelConfig);
            
            const { endpoint, adapterModel, maxTokens: configMaxTokens, extraBody } = modelConfig;
            const model = adapterModel || 'unknown';

            const payload = {
                model,
                messages: request.messages || [],
                stream: false
            };

            // Max tokens: config override takes precedence, then request value
            if (configMaxTokens !== undefined) {
                payload.max_tokens = configMaxTokens;
            } else if (request.maxTokens) {
                payload.max_tokens = request.maxTokens;
            }

            if (typeof request.temperature === 'number') payload.temperature = request.temperature;
            if (typeof request.top_p === 'number') payload.top_p = request.top_p;
            if (typeof request.frequency_penalty === 'number') payload.frequency_penalty = request.frequency_penalty;
            if (typeof request.presence_penalty === 'number') payload.presence_penalty = request.presence_penalty;
            if (request.stop) payload.stop = request.stop;

            // Config-level extraBody (applied to all requests)
            if (extraBody) {
                Object.assign(payload, extraBody);
            }

            // Request-level extra_body (overrides config)
            if (request.extra_body) {
                Object.assign(payload, request.extra_body);
            }

            const res = await httpRequest(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`llama.cpp Error: ${data.error.message || JSON.stringify(data.error)}`);
            }

            return { ...data, provider: 'llamacpp' };
        },

        /**
         * Streaming chat completion.
         */
        async *streamComplete(modelConfig, request) {
            await this.ensureServer(modelConfig);
            
            const { endpoint, adapterModel, maxTokens: configMaxTokens, extraBody, hardTokenCap } = modelConfig;
            const model = adapterModel || 'unknown';

            const payload = {
                model,
                messages: request.messages || [],
                stream: true
            };

            // Max tokens: config override takes precedence, then request value
            if (configMaxTokens !== undefined) {
                payload.max_tokens = configMaxTokens;
            } else if (request.maxTokens) {
                payload.max_tokens = request.maxTokens;
            }

            if (typeof request.temperature === 'number') payload.temperature = request.temperature;
            if (typeof request.top_p === 'number') payload.top_p = request.top_p;
            if (typeof request.frequency_penalty === 'number') payload.frequency_penalty = request.frequency_penalty;
            if (typeof request.presence_penalty === 'number') payload.presence_penalty = request.presence_penalty;
            if (request.stop) payload.stop = request.stop;

            // Config-level extraBody (applied to all requests)
            if (extraBody) {
                Object.assign(payload, extraBody);
            }

            // Request-level extra_body (overrides config)
            if (request.extra_body) {
                Object.assign(payload, request.extra_body);
            }

            const res = await httpRequest(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream' 
                },
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            // Hard token cap tracking
            let generatedTokens = 0;
            const tokenCap = hardTokenCap || configMaxTokens;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(':')) continue;

                        if (trimmed.startsWith('data: ')) {
                            const data = trimmed.slice(6);
                            if (data === '[DONE]') return;
                            try {
                                const parsed = JSON.parse(data);
                                parsed.provider = 'llamacpp';
                                
                                // Hard token cap check
                                if (tokenCap) {
                                    const content = parsed.choices?.[0]?.delta?.content || '';
                                    // Rough token estimation: ~4 chars per token for English
                                    const estimatedTokens = Math.ceil(content.length / 4);
                                    generatedTokens += estimatedTokens;
                                    
                                    if (generatedTokens >= tokenCap) {
                                        // Yield final chunk with finish_reason
                                        parsed.choices = parsed.choices || [];
                                        if (parsed.choices[0]) {
                                            parsed.choices[0].finish_reason = 'length';
                                            parsed.choices[0].delta = {}; // Clear delta to signal end
                                        }
                                        yield parsed;
                                        return; // Stop generation
                                    }
                                }
                                
                                yield parsed;
                            } catch (e) {
                                // Skip broken JSON
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
         */
        async createEmbedding(modelConfig, request) {
            const { endpoint, adapterModel } = modelConfig;
            const model = adapterModel || 'unknown';

            const payload = {
                input: Array.isArray(request.input) ? request.input : [request.input],
                model
            };

            const res = await httpRequest(`${endpoint}/v1/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`llama.cpp Embedding Error: ${data.error.message || JSON.stringify(data.error)}`);
            }

            return data;
        },

        /**
         * Generate image - not supported by llama.cpp.
         */
        async generateImage(modelConfig, request) {
            throw new Error('[LlamaCppAdapter] Image generation not supported by llama.cpp');
        },

        /**
         * Synthesize speech - not supported by llama.cpp.
         */
        async synthesizeSpeech(modelConfig, request) {
            throw new Error('[LlamaCppAdapter] TTS not supported by llama.cpp');
        },

        /**
         * Generate video - not supported by llama.cpp.
         */
        async generateVideo(modelConfig, request) {
            throw new Error('[LlamaCppAdapter] Video generation not supported by llama.cpp');
        },

        /**
         * List available models.
         */
        async listModels(modelConfig) {
            const { endpoint, capabilities } = modelConfig;
            const contextWindow = capabilities?.contextWindow || 4096;
            const hasVision = capabilities?.vision === true || modelConfig.localInference?.mmproj !== undefined;

            try {
                const res = await httpRequest(`${endpoint}/v1/models`);
                const data = await res.json();

                if (data.data && Array.isArray(data.data)) {
                    return data.data.map(m => ({
                        id: m.id,
                        object: 'model',
                        owned_by: m.owned_by || 'llamacpp',
                        capabilities: {
                            chat: true,
                            embeddings: false,
                            structuredOutput: true,
                            streaming: true,
                            vision: hasVision,
                            context_window: contextWindow
                        }
                    }));
                }
            } catch (e) {
                // llama.cpp server might not implement /v1/models
                // Return a single model based on config
            }

            // Fallback: return the configured model
            return [{
                id: modelConfig.adapterModel || 'unknown',
                object: 'model',
                owned_by: 'llamacpp',
                capabilities: {
                    chat: true,
                    embeddings: false,
                    structuredOutput: true,
                    streaming: true,
                    vision: hasVision,
                    context_window: contextWindow
                }
            }];
        }
    };
}
