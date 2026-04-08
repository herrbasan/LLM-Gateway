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

            logger.debug(`[llamacpp] Payload: ${JSON.stringify(payload).substring(0, 500)}`);

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
            
            // Thinking normalization - track if we're inside think tags
            let inThinkingMode = false;
            let thinkingBuffer = '';
            let sentReasoning = false;

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
                                
                                // Normalize thinking content from <think> tags
                                const delta = parsed.choices?.[0]?.delta;
                                if (delta?.content !== undefined) {
                                    let content = delta.content || '';
                                    
                                    // Check for <think> tag start
                                    if (content.includes('<think>')) {
                                        const thinkIndex = content.indexOf('<think>');
                                        if (thinkIndex > 0) {
                                            // Content before <think> - send as normal content
                                            delta.content = content.substring(0, thinkIndex);
                                        } else {
                                            delta.content = null;
                                        }
                                        // Extract content after <think> for processing
                                        content = content.substring(thinkIndex + 7);
                                        inThinkingMode = true;
                                    }
                                    
                                    // Check for </think> tag end
                                    if (inThinkingMode && content.includes('</think>')) {
                                        const endIndex = content.indexOf('</think>');
                                        // Add thinking content before </think>
                                        thinkingBuffer += content.substring(0, endIndex);
                                        // Content after </think> is the actual response
                                        content = content.substring(endIndex + 8);
                                        inThinkingMode = false;
                                        
                                        // Send reasoning_content first if we have it
                                        if (thinkingBuffer && !sentReasoning) {
                                            yield {
                                                provider: 'llamacpp',
                                                choices: [{
                                                    index: 0,
                                                    delta: {
                                                        reasoning_content: thinkingBuffer,
                                                        content: content || null
                                                    }
                                                }]
                                            };
                                            sentReasoning = true;
                                            continue; // Skip the normal yield
                                        }
                                    }
                                    
                                    // Handle content based on mode
                                    if (inThinkingMode) {
                                        // Accumulate thinking content
                                        thinkingBuffer += content;
                                        delta.content = null;
                                    } else if (content) {
                                        // Normal content (after </think>)
                                        delta.content = content;
                                    }
                                    
                                    // Remove null/empty content
                                    if (delta.content === null || delta.content === '') {
                                        delete delta.content;
                                    }
                                }
                                
                                // Hard token cap check
                                if (tokenCap) {
                                    const content = parsed.choices?.[0]?.delta?.content || '';
                                    const reasoning = parsed.choices?.[0]?.delta?.reasoning_content || '';
                                    // Rough token estimation: ~4 chars per token for English
                                    const estimatedTokens = Math.ceil((content.length + reasoning.length) / 4);
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
