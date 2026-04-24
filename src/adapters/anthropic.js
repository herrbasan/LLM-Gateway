/**
 * Anthropic Adapter - Protocol handler for Anthropic-compatible APIs.
 * Stateless - model config passed per-request.
 * Supports: Anthropic Claude, MiniMax, Qwen (Anthropic mode)
 */

import { request as httpRequest } from '../utils/http.js';

export function createAnthropicAdapter() {
    function parseArguments(args) {
        if (typeof args === 'string') {
            try { return JSON.parse(args); } catch { return {}; }
        }
        return args || {};
    }

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
            if (m.role === 'tool') {
                return {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: m.tool_call_id || m.tool_use_id,
                        content: m.content || ''
                    }]
                };
            }

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
            
            // Format assistant tool_calls to Anthropic format
            if (m.role === 'assistant' && m.tool_calls) {
                m.tool_calls.forEach(tc => {
                    if (tc.type === 'function' && tc.function) {
                        content.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function.name,
                            input: parseArguments(tc.function.arguments)
                        });
                    }
                });
            }

            return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
        }

        const content = [{ type: 'text', text: String(m.content || '') }];
        if (m.role === 'assistant' && m.tool_calls) {
            m.tool_calls.forEach(tc => {
                if (tc.type === 'function' && tc.function) {
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function.name,
                        input: parseArguments(tc.function.arguments)
                    });
                }
            });
        }
        
        return {
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content
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
        let tool_calls = null;
        
        if (data.content && Array.isArray(data.content)) {
            const textBlock = data.content.find(b => b.type === 'text');
            if (textBlock) content = textBlock.text;
            
            const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
            if (toolUseBlocks.length > 0) {
                tool_calls = toolUseBlocks.map(block => ({
                    id: block.id,
                    type: 'function',
                    function: {
                        name: block.name,
                        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input)
                    }
                }));
            }
        } else if (typeof data.content === 'string') {
            content = data.content;
        }

        const message = { role: 'assistant', content: content || null };
        if (tool_calls) {
            message.tool_calls = tool_calls;
        }

        return {
            id: data.id || `anthropic-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            provider: 'anthropic',
            choices: [{
                index: 0,
                message,
                finish_reason: data.stop_reason === 'end_turn' ? 'stop' : (data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason)
            }],
            usage: {
                prompt_tokens: data.usage?.input_tokens || 0,
                completion_tokens: data.usage?.output_tokens || 0,
                total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
            }
        };
    }

    function convertToolsFormat(tools, toolChoice) {
        if (!tools || !Array.isArray(tools)) return {};

        const claudeTools = tools.map(tool => {
            if (tool.type === 'function' && tool.function) {
                return {
                    name: tool.function.name,
                    description: tool.function.description || '',
                    input_schema: tool.function.parameters || { type: 'object', properties: {} }
                };
            }
            return tool;
        });

        let claudeToolChoice = undefined;
        if (toolChoice) {
            if (toolChoice === 'auto') {
                claudeToolChoice = { type: 'auto' };
            } else if (toolChoice === 'required') {
                claudeToolChoice = { type: 'any' }; // Map required to any
            } else if (toolChoice.type === 'function' && toolChoice.function?.name) {
                claudeToolChoice = { type: 'tool', name: toolChoice.function.name };
            } else if (typeof toolChoice === 'string' && toolChoice !== 'none') {
                claudeToolChoice = { type: 'tool', name: toolChoice };
            }
        }

        return { claudeTools, claudeToolChoice };
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
            
            // Tools conversion
            if (request.tools) {
                const { claudeTools, claudeToolChoice } = convertToolsFormat(request.tools, request.tool_choice);
                if (claudeTools && claudeTools.length > 0) {
                    body.tools = claudeTools;
                    if (claudeToolChoice) body.tool_choice = claudeToolChoice;
                }
            }

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

            // Tools conversion
            if (request.tools) {
                const { claudeTools, claudeToolChoice } = convertToolsFormat(request.tools, request.tool_choice);
                if (claudeTools && claudeTools.length > 0) {
                    body.tools = claudeTools;
                    if (claudeToolChoice) body.tool_choice = claudeToolChoice;
                }
            }

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
            let inputTokens = 0;
            let outputTokens = 0;

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
                            if (event.type === 'message_start' && event.message?.usage) {
                                inputTokens = event.message.usage.input_tokens || 0;
                            }
                            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
                                yield {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    provider: 'anthropic',
                                    choices: [{
                                        index: 0,
                                        delta: {
                                            tool_calls: [{
                                                index: event.index,
                                                id: event.content_block.id,
                                                type: 'function',
                                                function: { name: event.content_block.name, arguments: '' }
                                            }]
                                        },
                                        finish_reason: null
                                    }]
                                };
                            }
                            if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
                                yield {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    provider: 'anthropic',
                                    choices: [{
                                        index: 0,
                                        delta: {
                                            tool_calls: [{
                                                index: event.index,
                                                function: { arguments: event.delta.partial_json }
                                            }]
                                        },
                                        finish_reason: null
                                    }]
                                };
                            }
                            if (event.type === 'content_block_delta' && event.delta?.text) {
                                yield {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    provider: 'anthropic',
                                    choices: [{
                                        index: 0,
                                        delta: { content: event.delta.text },
                                        finish_reason: null
                                    }]
                                };
                            }
                            if (event.type === 'message_delta') {
                                if (event.usage) {
                                    outputTokens = event.usage.output_tokens || 0;
                                }
                                let finishReason = event.delta?.stop_reason;
                                if (finishReason === 'end_turn') finishReason = 'stop';
                                else if (finishReason === 'tool_use') finishReason = 'tool_calls';

                                yield {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    provider: 'anthropic',
                                    choices: [{
                                        index: 0,
                                        delta: {},
                                        finish_reason: finishReason || 'stop'
                                    }],
                                    usage: {
                                        prompt_tokens: inputTokens,
                                        completion_tokens: outputTokens,
                                        total_tokens: inputTokens + outputTokens
                                    }
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
