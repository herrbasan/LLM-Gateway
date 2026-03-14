/**
 * DashScope Adapter - For Alibaba Cloud Qwen models.
 * Handles special endpoints for TTS that don't follow OpenAI format.
 */

import { request as httpRequest } from '../utils/http.js';

export function createDashScopeAdapter() {
    return {
        name: 'dashscope',

        /**
         * Synthesize speech using Qwen TTS models.
         * Uses the multimodal-generation endpoint.
         */
        async synthesizeSpeech(modelConfig, requestOpts) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;

            // Validate voice
            const supportedVoices = capabilities?.supportedVoices;
            let voice = requestOpts.voice || 'zhichu';
            
            if (supportedVoices && supportedVoices.length > 0) {
                if (!supportedVoices.includes(voice)) {
                    throw new Error(`[DashScopeAdapter] Voice '${voice}' is not supported. Use one of: ${supportedVoices.join(', ')}`);
                }
            }

            // Build payload according to Qwen TTS API
            const payload = {
                model: adapterModel || 'qwen3-tts-flash',
                input: {
                    text: requestOpts.input,
                    voice: voice,
                    language_type: 'English'  // Default to English
                }
            };

            // Call the generation endpoint
            // The multimodal-generation endpoint is NOT part of compatible-mode
            const baseEndpoint = endpoint.replace('/compatible-mode/v1', '');
            const genRes = await httpRequest(`${baseEndpoint}/api/v1/services/aigc/multimodal-generation/generation`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const genData = await genRes.json();
            
            if (genData.error) {
                throw new Error(`DashScope TTS Error: ${genData.error.message}`);
            }

            // Extract audio URL from response
            const audioUrl = genData.output?.audio?.url;
            if (!audioUrl) {
                throw new Error('[DashScopeAdapter] No audio URL in response');
            }

            // Fetch the audio file
            const audioRes = await fetch(audioUrl);
            if (!audioRes.ok) {
                throw new Error(`[DashScopeAdapter] Failed to fetch audio: ${audioRes.status}`);
            }

            const arrayBuffer = await audioRes.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');

            // Determine mime type from URL or default to wav
            const format = requestOpts.response_format || 'wav';
            const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`;

            return {
                audio: base64,
                mimeType: mimeType
            };
        },

        /**
         * Chat completion - delegate to OpenAI-compatible endpoint if needed,
         * or throw error if not supported.
         */
        async chatComplete(modelConfig, request) {
            throw new Error('[DashScopeAdapter] Chat not supported. Use openai adapter for Qwen chat models.');
        },

        async streamComplete(modelConfig, request) {
            throw new Error('[DashScopeAdapter] Streaming not supported. Use openai adapter for Qwen chat models.');
        },

        async createEmbedding(modelConfig, request) {
            throw new Error('[DashScopeAdapter] Embeddings not supported. Use openai adapter for Qwen embedding models.');
        },

        async generateImage(modelConfig, request) {
            throw new Error('[DashScopeAdapter] Image generation not supported.');
        }
    };
}
