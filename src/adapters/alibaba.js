/**
 * Alibaba Cloud (DashScope) Adapter - Unified handler for Qwen models.
 * Uses the OpenAI SDK for chat/embeddings/streaming via DashScope's compatible endpoint,
 * and native DashScope API for TTS and image generation.
 */

import OpenAI from 'openai';
import { request as httpRequest } from '../utils/http.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

const DASHSCOPE_COMPATIBLE_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

function resolveEndpoint(modelConfig) {
    if (modelConfig.endpoint) return modelConfig.endpoint;
    return DASHSCOPE_COMPATIBLE_BASE;
}

function createClient(modelConfig) {
    return new OpenAI({
        apiKey: modelConfig.apiKey,
        baseURL: resolveEndpoint(modelConfig),
        defaultHeaders: modelConfig.headers || {}
    });
}

function getNativeBaseEndpoint(endpoint) {
    const base = endpoint || DASHSCOPE_COMPATIBLE_BASE;
    return base.replace('/compatible-mode/v1', '');
}

function buildNativeHeaders(apiKey) {
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };
}

function extractDashScopeParams(request) {
    const params = {};
    if (request.enable_search != null) params.enable_search = request.enable_search;
    if (request.enable_thinking != null) params.enable_thinking = request.enable_thinking;
    if (typeof request.top_k === 'number') params.top_k = request.top_k;
    if (typeof request.repetition_penalty === 'number') params.repetition_penalty = request.repetition_penalty;
    if (request.vl_high_resolution_images != null) params.vl_high_resolution_images = request.vl_high_resolution_images;
    if (typeof request.min_pixels === 'number') params.min_pixels = request.min_pixels;
    if (typeof request.max_pixels === 'number') params.max_pixels = request.max_pixels;
    if (typeof request.total_pixels === 'number') params.total_pixels = request.total_pixels;
    return params;
}

function buildChatPayload(modelConfig, request) {
    const { adapterModel, capabilities } = modelConfig;
    const model = adapterModel || 'qwen-plus';

    const payload = {
        model,
        messages: request.messages || []
    };

    if (request.maxTokens) {
        const maxOutput = capabilities?.maxOutputTokens;
        payload.max_tokens = maxOutput
            ? Math.min(request.maxTokens, maxOutput)
            : request.maxTokens;
    }
    if (typeof request.temperature === 'number') payload.temperature = request.temperature;
    if (typeof request.topP === 'number') payload.top_p = request.topP;
    if (request.stop) payload.stop = request.stop;

    if (request.schema && capabilities?.structuredOutput) {
        payload.response_format = {
            type: 'json_schema',
            json_schema: { name: 'response', strict: true, schema: request.schema }
        };
    }

    const dashscopeParams = extractDashScopeParams(request);
    if (Object.keys(dashscopeParams).length > 0) {
        Object.assign(payload, dashscopeParams);
    }

    return { payload, model };
}

function toPlainObject(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(toPlainObject);
    if (typeof obj.toJSON === 'function') return obj.toJSON();
    if (obj instanceof Date) return obj.toISOString();
    const result = {};
    for (const key of Object.keys(obj)) {
        result[key] = toPlainObject(obj[key]);
    }
    return result;
}

export function createAlibabaAdapter() {
    return {
        name: 'alibaba',

        async chatComplete(modelConfig, request) {
            const client = createClient(modelConfig);
            const { payload, model } = buildChatPayload(modelConfig, request);

            logger.info('Sending chat completion request', {
                endpoint: modelConfig.endpoint,
                model,
                stream: false,
                max_tokens: payload.max_tokens ?? null,
                temperature: payload.temperature ?? null,
                enable_search: payload.enable_search ?? null,
                enable_thinking: payload.enable_thinking ?? null
            }, 'AlibabaAdapter');

            const response = await client.chat.completions.create({
                ...payload,
                stream: false
            }, { signal: request.signal || null });

            const data = toPlainObject(response);
            data.provider = 'alibaba';
            return data;
        },

        async *streamComplete(modelConfig, request) {
            const client = createClient(modelConfig);
            const { payload, model } = buildChatPayload(modelConfig, request);

            logger.info('Sending streaming chat request', {
                endpoint: modelConfig.endpoint,
                model,
                stream: true,
                max_tokens: payload.max_tokens ?? null,
                temperature: payload.temperature ?? null,
                enable_search: payload.enable_search ?? null,
                enable_thinking: payload.enable_thinking ?? null
            }, 'AlibabaAdapter');

            const stream = await client.chat.completions.create({
                ...payload,
                stream: true,
                stream_options: { include_usage: true }
            }, { signal: request.signal || null });

            let chunkCount = 0;
            let contentChars = 0;

            try {
                for await (const chunk of stream) {
                    chunkCount++;
                    const delta = chunk.choices?.[0]?.delta;
                    if (delta?.content) {
                        contentChars += delta.content.length;
                    }

                    const plain = toPlainObject(chunk);
                    plain.provider = 'alibaba';
                    yield plain;
                }
            } finally {
                logger.info('Stream completed', {
                    model,
                    chunk_count: chunkCount,
                    content_chars: contentChars
                }, 'AlibabaAdapter');
            }
        },

        async createEmbedding(modelConfig, request) {
            const client = createClient(modelConfig);
            const { adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'text-embedding-v3';

            const params = {
                input: Array.isArray(request.input) ? request.input : [request.input],
                model
            };

            if (typeof request.dimensions === 'number' || typeof capabilities?.dimensions === 'number') {
                params.dimensions = request.dimensions || capabilities.dimensions;
            }

            if (request.encoding_format) {
                params.encoding_format = request.encoding_format;
            }

            const response = await client.embeddings.create(params);
            return toPlainObject(response);
        },

        async synthesizeSpeech(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;

            const supportedVoices = capabilities?.supportedVoices;
            let voice = request.voice || 'zhichu';

            if (supportedVoices && supportedVoices.length > 0) {
                if (!supportedVoices.includes(voice)) {
                    throw new Error(`[AlibabaAdapter] Voice '${voice}' is not supported. Use one of: ${supportedVoices.join(', ')}`);
                }
            }

            const language = request.language || request.language_type || 'English';

            const payload = {
                model: adapterModel || 'qwen3-tts-flash',
                input: {
                    text: request.input,
                    voice,
                    language_type: language
                }
            };

            const baseEndpoint = getNativeBaseEndpoint(endpoint);
            const genRes = await httpRequest(
                `${baseEndpoint}/api/v1/services/aigc/multimodal-generation/generation`,
                {
                    method: 'POST',
                    headers: buildNativeHeaders(apiKey),
                    body: JSON.stringify(payload)
                }
            );

            const genData = await genRes.json();

            if (genData.error) {
                throw new Error(`Alibaba TTS Error: ${genData.error.message}`);
            }

            const audioUrl = genData.output?.audio?.url;
            if (!audioUrl) {
                throw new Error('[AlibabaAdapter] No audio URL in TTS response');
            }

            const audioRes = await fetch(audioUrl);
            if (!audioRes.ok) {
                throw new Error(`[AlibabaAdapter] Failed to fetch audio: ${audioRes.status}`);
            }

            const arrayBuffer = await audioRes.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');

            const format = request.response_format || 'wav';
            const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`;

            return { audio: base64, mimeType };
        },

        async generateImage(modelConfig, request) {
            const { endpoint, apiKey, adapterModel } = modelConfig;

            const payload = {
                model: adapterModel || 'qwen-image-2.0',
                input: {
                    prompt: request.prompt
                }
            };

            const parameters = {};
            if (request.size) parameters.size = request.size;
            if (request.n) parameters.n = request.n;
            if (request.style) parameters.style = request.style;
            if (request.seed != null) parameters.seed = request.seed;
            if (Object.keys(parameters).length > 0) {
                payload.parameters = parameters;
            }

            const baseEndpoint = getNativeBaseEndpoint(endpoint);
            const genRes = await httpRequest(
                `${baseEndpoint}/api/v1/services/aigc/text2image/image-synthesis`,
                {
                    method: 'POST',
                    headers: buildNativeHeaders(apiKey),
                    body: JSON.stringify(payload)
                }
            );

            const genData = await genRes.json();

            if (genData.error) {
                throw new Error(`Alibaba Image Error: ${genData.error.message}`);
            }

            const taskStatus = genData.output?.task_status;
            const taskId = genData.output?.task_id;

            if (taskStatus === 'SUCCEEDED') {
                return this._resolveImageResult(genData);
            }

            if (taskStatus === 'FAILED') {
                const msg = genData.output?.message || genData.output?.code || 'Unknown error';
                throw new Error(`Alibaba Image Error: ${msg}`);
            }

            if (taskId) {
                return this._pollImageTask(baseEndpoint, apiKey, taskId);
            }

            throw new Error('[AlibabaAdapter] Unexpected image generation response');
        },

        async _pollImageTask(baseEndpoint, apiKey, taskId) {
            const maxAttempts = 60;
            const pollIntervalMs = 3000;

            for (let i = 0; i < maxAttempts; i++) {
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

                const res = await httpRequest(
                    `${baseEndpoint}/api/v1/tasks/${taskId}`,
                    { headers: buildNativeHeaders(apiKey) }
                );

                const data = await res.json();
                const status = data.output?.task_status;

                if (status === 'SUCCEEDED') {
                    return this._resolveImageResult(data);
                }

                if (status === 'FAILED') {
                    const msg = data.output?.message || data.output?.code || 'Unknown error';
                    throw new Error(`Alibaba Image Error: ${msg}`);
                }
            }

            throw new Error('[AlibabaAdapter] Image generation timed out');
        },

        async _resolveImageResult(data) {
            const results = data.output?.results || data.output?.rendering?.results || [];
            const images = [];

            for (const result of results) {
                if (result.url) {
                    const imgRes = await fetch(result.url);
                    if (imgRes.ok) {
                        const arrayBuffer = await imgRes.arrayBuffer();
                        const base64 = Buffer.from(arrayBuffer).toString('base64');
                        images.push({ b64_json: base64 });
                    }
                } else if (result.b64_image) {
                    images.push({ b64_json: result.b64_image });
                }
            }

            return {
                created: Math.floor(Date.now() / 1000),
                data: images
            };
        },

        async listModels(modelConfig) {
            const client = createClient(modelConfig);

            const response = await client.models.list();
            const models = [];

            for await (const model of response) {
                const id = (model.id || '').toLowerCase();

                if (id.includes('moderation')) continue;

                const isEmbedding = ['embed', 'embedding'].some(p => id.includes(p));
                const isVision = !isEmbedding && [
                    'qwen-vl', 'qwen2.5-vl', 'qwen2-vl', 'qwen3-vl',
                    'qwen-omni', 'qwen2.5-omni', 'qwen3-omni'
                ].some(p => id.includes(p));
                const isAudio = !isEmbedding && [
                    'tts', 'asr'
                ].some(p => id.includes(p));
                const isImage = !isEmbedding && !isAudio && [
                    'wanx', 'image', 'flux'
                ].some(p => id.includes(p));

                models.push({
                    id: model.id,
                    object: 'model',
                    owned_by: 'alibaba',
                    capabilities: {
                        chat: !isEmbedding && !isAudio && !isImage,
                        embeddings: isEmbedding,
                        structuredOutput: !isEmbedding && !isAudio && !isImage,
                        streaming: !isEmbedding && !isAudio && !isImage,
                        vision: isVision,
                        audio: isAudio,
                        image: isImage
                    }
                });
            }

            return models;
        }
    };
}
