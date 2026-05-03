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
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

function buildModelHeaders(localInference) {
    if (!localInference || !localInference.enabled) {
        return {};
    }
    const headers = {};
    if (localInference.modelPath) headers['X-Model-Path'] = localInference.modelPath;
    if (localInference.contextSize !== undefined) headers['X-Model-CtxSize'] = String(localInference.contextSize);
    if (localInference.gpuLayers !== undefined) headers['X-Model-GpuLayers'] = String(localInference.gpuLayers);
    if (localInference.flashAttention !== undefined) headers['X-Model-FlashAttention'] = String(localInference.flashAttention);
    if (localInference.mmproj) headers['X-Model-Mmproj'] = localInference.mmproj;
    if (localInference.embedding !== undefined) headers['X-Model-Embedding'] = String(localInference.embedding);
    if (localInference.pooling) headers['X-Model-Pooling'] = localInference.pooling;
    if (localInference.batchSize !== undefined) headers['X-Model-BatchSize'] = String(localInference.batchSize);
    if (localInference.mlock !== undefined) headers['X-Model-Mlock'] = String(localInference.mlock);
    return headers;
}

export function createLlamaCppAdapter() {
    return {
        name: 'llamacpp',

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            
            const { endpoint, adapterModel, maxTokens: configMaxTokens, extraBody, localInference } = modelConfig;
            const model = adapterModel || 'unknown';
            const modelHeaders = buildModelHeaders(localInference);

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
            if (request.tools) payload.tools = request.tools;
            if (request.tool_choice) payload.tool_choice = request.tool_choice;
            if (request.response_format) payload.response_format = request.response_format;

            // Config-level extraBody (applied to all requests)
            if (extraBody) {
                Object.assign(payload, extraBody);
            }

            // Request-level extra_body (overrides config)
            if (request.extra_body) {
                Object.assign(payload, request.extra_body);
            }

            // Thinking control (overrides extraBody/extra_body)
            if (request.enable_thinking != null) {
                payload.chat_template_kwargs = {
                    ...payload.chat_template_kwargs,
                    enable_thinking: request.enable_thinking
                };
            }

            logger.debug(`[llamacpp] Payload: ${JSON.stringify(payload).substring(0, 500)}`);

            const res = await httpRequest(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...modelHeaders
                },
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`llama.cpp Error: ${data.error.message || JSON.stringify(data.error)}`);
            }

            // Non-streaming hallucinated tool trap
            if (request.tools && data.choices && data.choices.length > 0) {
                let content = data.choices[0].message?.content || '';
                let toolIdx = content.indexOf('{"name":');
                if (toolIdx === -1) toolIdx = content.indexOf('```json\n{"name":');
                
                if (toolIdx !== -1) {
                    let toolJsonStr = content.substring(toolIdx);
                    let firstBrace = toolJsonStr.indexOf('{');
                    let lastBrace = toolJsonStr.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1) {
                        try {
                            let parsedTool = JSON.parse(toolJsonStr.substring(firstBrace, lastBrace + 1));
                            if (parsedTool.name) {
                                data.choices[0].message.content = content.substring(0, toolIdx) || null;
                                data.choices[0].message.tool_calls = [{
                                    id: 'call_' + Math.random().toString(36).substring(2, 9),
                                    type: 'function',
                                    function: {
                                        name: parsedTool.name,
                                        arguments: typeof parsedTool.arguments === 'string' ? parsedTool.arguments : JSON.stringify(parsedTool.arguments || {})
                                    }
                                }];
                                data.choices[0].finish_reason = 'tool_calls';
                            }
                        } catch (e) {
                            logger.debug(`[llamacpp] Failed to parse intercepted tool call hallucination: ${e.message}`);
                        }
                    }
                }
            }

            return { ...data, provider: 'llamacpp' };
        },

        /**
         * Streaming chat completion.
         */
        async *streamComplete(modelConfig, request) {
            
            const { endpoint, adapterModel, maxTokens: configMaxTokens, extraBody, hardTokenCap, localInference } = modelConfig;
            const model = adapterModel || 'unknown';
            const modelHeaders = buildModelHeaders(localInference);

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
            if (request.tools) payload.tools = request.tools;
            if (request.tool_choice) payload.tool_choice = request.tool_choice;
            if (request.response_format) payload.response_format = request.response_format;

            // Config-level extraBody (applied to all requests)
            if (extraBody) {
                Object.assign(payload, extraBody);
            }

            // Request-level extra_body (overrides config)
            if (request.extra_body) {
                Object.assign(payload, request.extra_body);
            }

            // Thinking control (overrides extraBody/extra_body)
            if (request.enable_thinking != null) {
                payload.chat_template_kwargs = {
                    ...payload.chat_template_kwargs,
                    enable_thinking: request.enable_thinking
                };
            }

            payload.stream_options = { ...request.stream_options, include_usage: true };

            const res = await httpRequest(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    ...modelHeaders
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
            
            // Track thinking mode to suppress tool detection during reasoning
            let inThinkingMode = false;

            // Hallucinated Tool Catching State
            let responseBuffer = '';
            let textStreamed = 0;
            let inToolBlock = false;
            const fallbackToolCallId = 'call_' + Math.random().toString(36).substring(2, 9);

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
                            if (data === '[DONE]') {
                                if (inToolBlock && request.tools) {
                                    let toolJsonStr = responseBuffer.substring(textStreamed);
                                    let firstBrace = toolJsonStr.indexOf('{');
                                    let lastBrace = toolJsonStr.lastIndexOf('}');
                                    if (firstBrace !== -1 && lastBrace !== -1) {
                                        try {
                                            let parsedTool = JSON.parse(toolJsonStr.substring(firstBrace, lastBrace + 1));
                                            if (parsedTool.name) {
                                                yield {
                                                    provider: 'llamacpp',
                                                    choices: [{
                                                        index: 0,
                                                        delta: {
                                                            tool_calls: [{
                                                                index: 0,
                                                                id: fallbackToolCallId,
                                                                type: 'function',
                                                                function: {
                                                                    name: parsedTool.name,
                                                                    arguments: typeof parsedTool.arguments === 'string' ? parsedTool.arguments : JSON.stringify(parsedTool.arguments || {})
                                                                }
                                                            }]
                                                        },
                                                        finish_reason: 'tool_calls'
                                                    }]
                                                };
                                            }
                                        } catch (e) {
                                            logger.debug(`[llamacpp] Failed to parse intercepted tool call hallucination: ${e.message}`);
                                        }
                                    }
                                }
                                return;
                            }
                            try {
                                const parsed = JSON.parse(data);
                                parsed.provider = 'llamacpp';
                                
                                // Pass content through; central extractor handles <think> tags
                                const delta = parsed.choices?.[0]?.delta;
                                if (delta?.content !== undefined) {
                                    let content = delta.content || '';

                                    if (content.includes('<think>')) {
                                        inThinkingMode = true;
                                    }
                                    if (inThinkingMode && content.includes('</think>')) {
                                        inThinkingMode = false;
                                    }

                                    if (inThinkingMode) {
                                        // Pass through for central extractor; suppress tool detection
                                    } else if (content) {
                                        responseBuffer += content;
                                        let toolIdx = responseBuffer.indexOf('{"name":');
                                        if (toolIdx === -1) toolIdx = responseBuffer.indexOf('```json\n{"name":');

                                        if (request.tools && toolIdx !== -1) {
                                            inToolBlock = true;
                                            let textBefore = responseBuffer.substring(textStreamed, toolIdx);
                                            if (textBefore) {
                                                delta.content = textBefore;
                                                textStreamed = toolIdx;
                                            } else {
                                                delta.content = null;
                                            }
                                        } else if (inToolBlock) {
                                            delta.content = null;
                                        } else {
                                            let newText = responseBuffer.substring(textStreamed);
                                            let lastBrace = newText.lastIndexOf('{');
                                            let lastTicks = newText.lastIndexOf('`');

                                            // Lookahead holding back possible start of JSON
                                            if (request.tools && (lastBrace !== -1 || lastTicks !== -1) && (newText.length - Math.max(lastBrace, lastTicks)) < 20) {
                                                let safeIdx = Math.max(lastBrace, lastTicks);
                                                let safeText = newText.substring(0, safeIdx);
                                                if (safeText) {
                                                    delta.content = safeText;
                                                    textStreamed += safeText.length;
                                                } else {
                                                    delta.content = null;
                                                }
                                            } else {
                                                delta.content = newText;
                                                textStreamed = responseBuffer.length;
                                            }
                                        }
                                    }

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
            const { endpoint, adapterModel, capabilities, localInference } = modelConfig;
            const model = adapterModel || 'unknown';
            const modelHeaders = buildModelHeaders(localInference);

            const payload = {
                input: Array.isArray(request.input) ? request.input : [request.input],
                model
            };

            if (request.dimensions) {
                payload.dimensions = request.dimensions;
            } else if (capabilities?.dimensions) {
                payload.dimensions = capabilities.dimensions;
            }

            const res = await httpRequest(`${endpoint}/v1/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...modelHeaders
                },
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
            const hasVision = capabilities?.vision === true;

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
