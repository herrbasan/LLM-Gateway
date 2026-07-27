/**
 * OpenAI Adapter - Protocol handler for OpenAI-compatible APIs.
 * Stateless - model config passed per-request.
 */

import { request as httpRequest, readWithDeadline } from '../utils/http.js';

export function createOpenAIAdapter() {
    return {
        name: 'openai',

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities, headers: customHeaders } = modelConfig;
            const model = adapterModel;

            const payload = {
                model,
                messages: request.messages || [],
                stream: false
            };

            applyTokenParams(payload, request, capabilities);
            applyStandardParams(payload, request, modelConfig);
            applyFormatParams(payload, request, capabilities);
            applyToolParams(payload, request);
            applyLogprobParams(payload, request);
            applyThinkingControl(payload, request, capabilities);

            // Strip parameters the model doesn't support (e.g. reasoning models reject temperature)
            const excludeParams = capabilities?.excludeParams;
            if (Array.isArray(excludeParams)) {
                for (const key of excludeParams) {
                    delete payload[key];
                }
            }

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
            const model = adapterModel;

            const payload = {
                model,
                messages: request.messages || [],
                stream: true
            };

            applyTokenParams(payload, request, capabilities);
            applyStandardParams(payload, request, modelConfig);
            applyFormatParams(payload, request, capabilities);
            applyToolParams(payload, request);
            applyLogprobParams(payload, request);
            applyThinkingControl(payload, request, capabilities);

            if (request.stream_options) {
                payload.stream_options = request.stream_options;
            }

            // Strip parameters the model doesn't support (e.g. reasoning models reject temperature)
            const excludeParams = capabilities?.excludeParams;
            if (Array.isArray(excludeParams)) {
                for (const key of excludeParams) {
                    delete payload[key];
                }
            }

            const headers = buildHeaders(apiKey, { 'Accept': 'text/event-stream' }, customHeaders);
            const res = await httpRequest(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errorStr = await res.text();
                throw new Error(`OpenAI API Streaming Error (${res.status}): ${errorStr}`);
            }

            // Guard against APIs that return 200 with JSON error bodies (e.g. Kimi Coding API).
            // If the response isn't SSE, read it as JSON and surface any error.
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('text/event-stream')) {
                const body = await res.text();
                let parsed;
                try { parsed = JSON.parse(body); } catch { /* not JSON */ }
                if (parsed?.error) {
                    const err = new Error(`OpenAI API Error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
                    err.status = parsed.error.code || 500;
                    throw err;
                }
                throw new Error(`OpenAI API unexpected response type: ${contentType}. Body: ${body.slice(0, 500)}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await readWithDeadline(reader);
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(':')) continue;
                        if (trimmed.startsWith('data:')) {
                            const data = trimmed.slice(5).trimStart();
                            if (data === '[DONE]') return;
                            try {
                                const parsed = JSON.parse(data);
                                parsed.provider = 'openai';
                                yield parsed;
                            } catch (e) {
                                // Malformed SSE data line — log but don't halt the stream.
                                // A single corrupt line shouldn't kill the entire response.
                                if (data.length > 0 && data !== '[DONE]') {
                                    console.error(`[OpenAIAdapter] Failed to parse SSE data line: ${data.slice(0, 200)}`);
                                }
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
            const { endpoint, apiKey, adapterModel, headers: customHeaders, capabilities } = modelConfig;
            const model = adapterModel;

            const payload = {
                input: Array.isArray(request.input) ? request.input : [request.input],
                model
            };

            const dimensions = request.dimensions ?? modelConfig.dimensions ?? capabilities?.dimensions;
            if (typeof dimensions === 'number') {
                payload.dimensions = dimensions;
            }

            // Strip parameters the model doesn't support
            const excludeParamsEmb = capabilities?.excludeParams;
            if (Array.isArray(excludeParamsEmb)) {
                for (const key of excludeParamsEmb) {
                    delete payload[key];
                }
            }

            const headers = buildHeaders(apiKey, {}, customHeaders);
            const res = await httpRequest(`${endpoint}/embeddings`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                const err = new Error(`OpenAI Embedding HTTP ${res.status}: ${body.slice(0, 500)}`);
                err.status = res.status;
                throw err;
            }

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
                model: adapterModel,
                prompt: request.prompt,
                n: request.n || 1,
                response_format: 'b64_json'
            };

            // Only include size if the model supports it (xAI doesn't support this parameter)
            const supportsSize = capabilities?.supportsSizeParameter !== false;
            if (supportsSize) {
                payload.size = request.size || '1024x1024';
            }

            // Strip parameters the model doesn't support
            const excludeParamsImg = capabilities?.excludeParams;
            if (Array.isArray(excludeParamsImg)) {
                for (const key of excludeParamsImg) {
                    delete payload[key];
                }
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
                model: adapterModel,
                input: request.input,
                voice,
                response_format: request.response_format || 'mp3'
            };

            if (request.speed) payload.speed = request.speed;

            // Strip parameters the model doesn't support
            const excludeParamsTTS = capabilities?.excludeParams;
            if (Array.isArray(excludeParamsTTS)) {
                for (const key of excludeParamsTTS) {
                    delete payload[key];
                }
            }

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
                model: adapterModel,
                prompt: request.prompt,
                duration: request.duration || 5,
                resolution: request.resolution || '720p'
            };

            if (request.quality) payload.quality = request.quality;

            // Strip parameters the model doesn't support
            const excludeParamsVid = capabilities?.excludeParams;
            if (Array.isArray(excludeParamsVid)) {
                for (const key of excludeParamsVid) {
                    delete payload[key];
                }
            }

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

function applyStandardParams(payload, request, modelConfig) {
    // Model-level overrides take precedence when explicitly configured.
    // This lets a model declare "I only accept temperature: 1" in config
    // rather than silently deleting what the client sends.
    if (typeof modelConfig?.temperature === 'number') {
        payload.temperature = modelConfig.temperature;
    } else if (typeof request.temperature === 'number') {
        payload.temperature = request.temperature;
    }
    if (typeof modelConfig?.top_p === 'number') {
        payload.top_p = modelConfig.top_p;
    } else if (typeof request.top_p === 'number') {
        payload.top_p = request.top_p;
    }
    if (typeof request.frequency_penalty === 'number') payload.frequency_penalty = request.frequency_penalty;
    if (typeof request.presence_penalty === 'number') payload.presence_penalty = request.presence_penalty;
    if (request.stop) payload.stop = request.stop;
    if (request.seed != null) payload.seed = request.seed;
    if (request.logit_bias) payload.logit_bias = request.logit_bias;
    if (request.user) payload.user = request.user;
    if (request.n != null) payload.n = request.n;

    // Config-level extraBody (applied to all requests for this model)
    if (modelConfig?.extraBody) {
        Object.assign(payload, modelConfig.extraBody);
    }

    // Request-level extra_body (overrides config)
    if (request.extra_body) {
        Object.assign(payload, request.extra_body);
    }
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

function applyThinkingControl(payload, request, capabilities) {
    // Only inject chat_template_kwargs for models that declare support.
    // This is a llama.cpp/Qwen-specific parameter — Grok, OpenRouter, etc. reject it.
    if (request.enable_thinking != null && capabilities?.thinking === 'chat_template_kwargs') {
        payload.chat_template_kwargs = {
            ...payload.chat_template_kwargs,
            enable_thinking: request.enable_thinking
        };
    }

    // xAI/Grok uses reasoning_effort (none/low/medium/high) instead of enable_thinking.
    // Map boolean enable_thinking to reasoning_effort for models that declare support.
    if (request.enable_thinking != null && capabilities?.reasoningEffort) {
        payload.reasoning_effort = request.enable_thinking ? 'high' : 'none';
    }
    
    // Strict reasoning history constraint for upstream APIs that enforce it
    // (Moonshot/Kimi/DeepSeek). Assistant messages containing tool calls MUST
    // natively possess a `reasoning_content` property, even if empty.
    // This is a non-spec field: only inject it for models that explicitly
    // declare capabilities.reasoningContent === true. Applying it universally
    // mutated history for every upstream (incl. real OpenAI/Grok/OpenRouter)
    // and copied the entire messages array on every request for no benefit.
    if (capabilities?.reasoningContent === true && Array.isArray(payload.messages)) {
        payload.messages = payload.messages.map(msg => {
            if (msg.role === 'assistant' && (msg.tool_calls != null || msg.function_call != null) && msg.reasoning_content == null) {
                return { ...msg, reasoning_content: "" };
            }
            return msg;
        });
    }
}

function buildHeaders(apiKey, extra = {}, custom = {}) {
    const headers = { ...extra, ...custom };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}
