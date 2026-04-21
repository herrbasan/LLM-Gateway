/**
 * OpenAI Adapter - Protocol handler for OpenAI-compatible APIs.
 * Stateless - model config passed per-request.
 */

import { request as httpRequest } from '../utils/http.js';

export function createOpenAIAdapter() {
    return {
        name: 'openai',

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities, headers: customHeaders } = modelConfig;
            const model = adapterModel || 'gpt-4';

            const payload = {
                model,
                messages: request.messages || [],
                stream: false
            };

            applyTokenParams(payload, request, capabilities);
            applyStandardParams(payload, request);
            applyFormatParams(payload, request, capabilities);
            applyToolParams(payload, request);
            applyLogprobParams(payload, request);
            applyThinkingControl(payload, request);

            const headers = buildHeaders(apiKey, {}, customHeaders);
            const res = await httpRequest(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                const err = new Error(`OpenAI API Error: ${data.error.message}`);
                err.status = data.error.code || 500;
                throw err;
            }

            return {
                ...data,
                provider: 'openai'
            };
        },

        /**
         * Streaming chat completion.
         */
        async *streamComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities, headers: customHeaders } = modelConfig;
            const model = adapterModel || 'gpt-4';

            const payload = {
                model,
                messages: request.messages || [],
                stream: true
            };

            applyTokenParams(payload, request, capabilities);
            applyStandardParams(payload, request);
            applyFormatParams(payload, request, capabilities);
            applyToolParams(payload, request);
            applyLogprobParams(payload, request);
            applyThinkingControl(payload, request);

            if (request.stream_options) payload.stream_options = request.stream_options;

            const headers = buildHeaders(apiKey, { 'Accept': 'text/event-stream' }, customHeaders);
            const res = await httpRequest(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
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
                        if (!trimmed || trimmed.startsWith(':')) continue;
                        if (trimmed.startsWith('data: ')) {
                            const data = trimmed.slice(6);
                            if (data === '[DONE]') return;
                            try {
                                const parsed = JSON.parse(data);
                                const delta = parsed.choices?.[0]?.delta;
                                if (delta && delta.content === null) {
                                    delete delta.content;
                                }
                                parsed.provider = 'openai';
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
            const { endpoint, apiKey, adapterModel, headers: customHeaders } = modelConfig;
            const model = adapterModel || 'text-embedding-3-small';

            const payload = {
                input: Array.isArray(request.input) ? request.input : [request.input],
                model
            };

            const headers = buildHeaders(apiKey, {}, customHeaders);
            const res = await httpRequest(`${endpoint}/embeddings`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`OpenAI Embedding Error: ${data.error.message}`);
            }

            return data;
        },

        /**
         * Generate image.
         */
        async generateImage(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities, headers: customHeaders } = modelConfig;

            const payload = {
                model: adapterModel || 'dall-e-3',
                prompt: request.prompt,
                n: request.n || 1,
                response_format: 'b64_json'
            };

            // Only include size if the model supports it (xAI doesn't support this parameter)
            const supportsSize = capabilities?.supportsSizeParameter !== false;
            if (supportsSize) {
                payload.size = request.size || '1024x1024';
            }

            const headers = buildHeaders(apiKey, {}, customHeaders);
            const res = await httpRequest(`${endpoint}/images/generations`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`OpenAI Image Error: ${data.error.message}`);
            }

            return {
                created: data.created,
                data: data.data.map(img => ({
                    b64_json: img.b64_json,
                    url: img.url,
                    revised_prompt: img.revised_prompt
                }))
            };
        },

        /**
         * Synthesize speech.
         */
        async synthesizeSpeech(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities, headers: customHeaders } = modelConfig;

            // Validate voice if supportedVoices is defined
            const supportedVoices = capabilities?.supportedVoices;
            let voice = request.voice || 'alloy';
            
            if (supportedVoices && supportedVoices.length > 0) {
                if (!supportedVoices.includes(voice)) {
                    throw new Error(`[OpenAIAdapter] Voice '${voice}' is not supported. Use one of: ${supportedVoices.join(', ')}`);
                }
            }

            const payload = {
                model: adapterModel || 'tts-1',
                input: request.input,
                voice,
                response_format: request.response_format || 'mp3'
            };

            if (request.speed) payload.speed = request.speed;

            const headers = buildHeaders(apiKey, {}, customHeaders);
            const res = await httpRequest(`${endpoint}/audio/speech`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            // Audio responses are binary
            const arrayBuffer = await res.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');

            return {
                audio: base64,
                mimeType: `audio/${payload.response_format}`
            };
        },

        /**
         * Generate video.
         * Note: OpenAI doesn't have a public video generation API yet.
         * This is a placeholder for future compatibility.
         */
        async generateVideo(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, headers: customHeaders } = modelConfig;

            const payload = {
                model: adapterModel || 'sora-1',
                prompt: request.prompt,
                duration: request.duration || 5,
                resolution: request.resolution || '720p'
            };

            if (request.quality) payload.quality = request.quality;

            const headers = buildHeaders(apiKey, {}, customHeaders);
            const res = await httpRequest(`${endpoint}/videos/generations`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`OpenAI Video Error: ${data.error.message}`);
            }

            return {
                created: data.created,
                data: data.data || []
            };
        },

        /**
         * List available models.
         */
        async listModels(modelConfig) {
            const { endpoint, apiKey, headers: customHeaders } = modelConfig;
            const headers = buildHeaders(apiKey, {}, customHeaders);

            const res = await httpRequest(`${endpoint}/models`, { headers });
            const data = await res.json();

            if (!data.data || !Array.isArray(data.data)) {
                throw new Error('[OpenAIAdapter] Invalid response from API');
            }

            const embeddingPatterns = ['embed', 'embedding'];
            const moderationPatterns = ['moderation'];
            const visionPatterns = [
                'vision', '-v', 'vl', '4v', '4.6v', 'gpt-4o', 'gemini', 'claude-3',
                'llava', 'bakllava', 'moondream', 'moonlight',
                'qwen2.5-vl', 'qwen-vl', 'qwen3-vl', 'glm-4v', 'glm-4.6v', 'cogvlm',
                'gemma-3', 'grok-2-vision'
            ];

            return data.data
                .filter(m => {
                    const id = m.id.toLowerCase();
                    return !moderationPatterns.some(p => id.includes(p));
                })
                .map(m => {
                    const id = m.id.toLowerCase();
                    const isEmbedding = embeddingPatterns.some(p => id.includes(p));
                    const isTextChat = !isEmbedding;
                    const isVision = isTextChat && visionPatterns.some(p => id.includes(p));

                    return {
                        id: m.id,
                        object: 'model',
                        owned_by: 'openai',
                        capabilities: {
                            chat: isTextChat,
                            embeddings: isEmbedding,
                            structuredOutput: isTextChat,
                            streaming: isTextChat,
                            vision: isVision
                        }
                    };
                });
        }
    };
}

function applyTokenParams(payload, request, capabilities) {
    const maxOutput = capabilities?.maxOutputTokens;

    if (request.maxCompletionTokens != null) {
        payload.max_completion_tokens = maxOutput
            ? Math.min(request.maxCompletionTokens, maxOutput)
            : request.maxCompletionTokens;
    } else if (request.maxTokens != null) {
        payload.max_tokens = maxOutput
            ? Math.min(request.maxTokens, maxOutput)
            : request.maxTokens;
    }
}

function applyStandardParams(payload, request) {
    if (typeof request.temperature === 'number') payload.temperature = request.temperature;
    if (typeof request.top_p === 'number') payload.top_p = request.top_p;
    if (typeof request.frequency_penalty === 'number') payload.frequency_penalty = request.frequency_penalty;
    if (typeof request.presence_penalty === 'number') payload.presence_penalty = request.presence_penalty;
    if (request.stop) payload.stop = request.stop;
    if (request.seed != null) payload.seed = request.seed;
    if (request.logit_bias) payload.logit_bias = request.logit_bias;
    if (request.user) payload.user = request.user;
    if (request.n != null) payload.n = request.n;
}

function applyFormatParams(payload, request, capabilities) {
    if (request.schema && capabilities?.structuredOutput) {
        payload.response_format = {
            type: 'json_schema',
            json_schema: { name: 'response', strict: true, schema: request.schema }
        };
    } else if (request.response_format) {
        payload.response_format = request.response_format;
    }
}

function applyToolParams(payload, request) {
    if (request.tools) payload.tools = request.tools;
    if (request.tool_choice) payload.tool_choice = request.tool_choice;
    if (request.parallel_tool_calls != null) payload.parallel_tool_calls = request.parallel_tool_calls;
    if (request.functions) payload.functions = request.functions;
    if (request.function_call) payload.function_call = request.function_call;
}

function applyLogprobParams(payload, request) {
    if (request.logprobs != null) payload.logprobs = request.logprobs;
    if (request.top_logprobs != null) payload.top_logprobs = request.top_logprobs;
}

function applyThinkingControl(payload, request) {
    if (request.enable_thinking != null) {
        payload.chat_template_kwargs = {
            ...payload.chat_template_kwargs,
            enable_thinking: request.enable_thinking
        };
    }
}

function buildHeaders(apiKey, extra = {}, custom = {}) {
    const headers = { ...extra, ...custom };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}
