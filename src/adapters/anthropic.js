/**
 * Anthropic Adapter - Protocol handler for Anthropic-compatible APIs.
 * Stateless - model config passed per-request.
 * Supports: Anthropic Claude, MiniMax, Qwen (Anthropic mode)
 */

import { request as httpRequest } from '../utils/http.js';

export function createAnthropicAdapter() {
    // Helper functions defined at factory scope
    function extractSystemPrompt(messages) {
        if (!messages) return { messages: [], systemPrompt: null };
        const systemMsg = messages.find(m => m.role === 'system');
        const otherMessages = messages.filter(m => m.role !== 'system');
        return {
            messages: otherMessages,
            systemPrompt: systemMsg?.content || null
        };
    }

    function formatMessages(messages) {
        if (!messages) return [];
        return messages.map(m => {
            if (Array.isArray(m.content)) {
                const content = m.content.map(part => {
                    if (part.type === 'text') {
                        return { type: 'text', text: part.text };
                    }
                    if (part.type === 'image_url') {
                        const url = part.image_url.url;
                        const match = url.match(/^data:([^;]+);base64,(.+)$/);
                        if (match) {
                            return {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: match[1] || 'image/jpeg',
                                    data: match[2]
                                }
                            };
                        }
                        return { type: 'image', source: { type: 'url', url } };
                    }
                    return { type: 'text', text: JSON.stringify(part) };
                });
                return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
            }
            return {
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: [{ type: 'text', text: String(m.content || '') }]
            };
        });
    }

    function buildHeaders(apiKey) {
        return {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    function normalizeResponse(data, model) {
        let content = '';
        if (data.content && Array.isArray(data.content)) {
            const textBlock = data.content.find(b => b.type === 'text');
            if (textBlock) content = textBlock.text;
        } else if (typeof data.content === 'string') {
            content = data.content;
        }
        return {
            id: data.id || `anthropic-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            provider: 'anthropic',
            choices: [{
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason
            }],
            usage: {
                prompt_tokens: data.usage?.input_tokens || 0,
                completion_tokens: data.usage?.output_tokens || 0,
                total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
            }
        };
    }

    return {
        name: 'anthropic',

        async chatComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'claude-3-opus-20240229';

            if (!apiKey) {
                throw new Error('[AnthropicAdapter] apiKey is required in modelConfig');
            }

            const { messages, systemPrompt } = extractSystemPrompt(request.messages);

            const body = {
                model,
                messages: formatMessages(messages),
                max_tokens: request.maxTokens ?? 4096
            };

            if (systemPrompt) body.system = systemPrompt;
            if (typeof request.temperature === 'number') body.temperature = request.temperature;
            if (request.schema && capabilities?.structuredOutput) {
                body.tools = [{
                    name: 'generate_response',
                    description: 'Generate a response matching the required schema',
                    input_schema: request.schema
                }];
                body.tool_choice = { type: 'tool', name: 'generate_response' };
            }

            const res = await httpRequest(`${endpoint}/v1/messages`, {
                method: 'POST',
                headers: buildHeaders(apiKey),
                signal: request.signal,
                body: JSON.stringify(body)
            });

            const data = await res.json();

            if (data.error) {
                throw new Error(`Anthropic API Error: ${data.error.message}`);
            }

            return normalizeResponse(data, model);
        },

        async *streamComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel } = modelConfig;
            const model = adapterModel || 'claude-3-opus-20240229';

            if (!apiKey) {
                throw new Error('[AnthropicAdapter] apiKey is required in modelConfig');
            }

            const { messages, systemPrompt } = extractSystemPrompt(request.messages);

            const body = {
                model,
                messages: formatMessages(messages),
                max_tokens: request.maxTokens ?? 4096,
                stream: true
            };

            if (systemPrompt) body.system = systemPrompt;
            if (typeof request.temperature === 'number') body.temperature = request.temperature;

            const res = await httpRequest(`${endpoint}/v1/messages`, {
                method: 'POST',
                headers: buildHeaders(apiKey),
                signal: request.signal,
                body: JSON.stringify(body)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const processId = `msg_${Date.now()}`;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const event = JSON.parse(data);
                            if (event.type === 'content_block_delta' && event.delta?.text) {
                                yield {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    choices: [{
                                        index: 0,
                                        delta: { content: event.delta.text },
                                        finish_reason: null
                                    }]
                                };
                            }
                            if (event.type === 'message_stop') {
                                yield {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    choices: [{
                                        index: 0,
                                        delta: {},
                                        finish_reason: 'stop'
                                    }]
                                };
                            }
                        } catch {
                            // Ignore parse errors
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }
        },

        async createEmbedding(modelConfig, request) {
            throw new Error('[AnthropicAdapter] Embeddings not supported');
        },

        async generateImage(modelConfig, request) {
            throw new Error('[AnthropicAdapter] Image generation not supported');
        },

        async synthesizeSpeech(modelConfig, request) {
            throw new Error('[AnthropicAdapter] TTS not supported');
        },

        async generateVideo(modelConfig, request) {
            throw new Error('[AnthropicAdapter] Video generation not supported');
        },

        async listModels(modelConfig) {
            const { endpoint, apiKey, capabilities } = modelConfig;
            const contextWindow = capabilities?.contextWindow || 200000;

            const defaultModels = [
                { id: 'claude-3-opus-20240229', context_window: 200000, vision: true },
                { id: 'claude-3-sonnet-20240229', context_window: 200000, vision: true },
                { id: 'claude-3-haiku-20240307', context_window: 200000, vision: true },
                { id: 'claude-3-5-sonnet-20241022', context_window: 200000, vision: true }
            ];

            try {
                const res = await httpRequest(`${endpoint}/v1/models`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                const data = await res.json();
                
                return (data.data || defaultModels).map(m => ({
                    id: m.id,
                    object: 'model',
                    owned_by: 'anthropic',
                    capabilities: {
                        chat: true,
                        vision: m.vision !== false && (m.id.includes('claude-3') || m.id.includes('vision')),
                        structured_output: true,
                        streaming: true,
                        context_window: m.context_window || contextWindow
                    }
                }));
            } catch {
                return defaultModels.map(m => ({
                    id: m.id,
                    object: 'model',
                    owned_by: 'anthropic',
                    capabilities: {
                        chat: true,
                        vision: m.vision,
                        structured_output: true,
                        streaming: true,
                        context_window: m.context_window
                    }
                }));
            }
        }
    };
}
