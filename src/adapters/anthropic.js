/**
 * Anthropic Adapter - Protocol handler for Anthropic-compatible APIs.
 * Stateless - model config passed per-request.
 * Supports: Anthropic Claude, MiniMax, Qwen (Anthropic mode)
 */

import { request as httpRequest } from '../utils/http.js';
import { getLogger } from '../utils/logger.js';

export function createAnthropicAdapter() {
    const logger = getLogger('AnthropicAdapter');
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

    function normalizeMessages(messages) {
        if (!messages || messages.length === 0) return [];

        const result = [];
        for (const msg of messages) {
            const prev = result[result.length - 1];

            if (prev?.role === 'assistant' && msg.role === 'assistant') {
                if (msg.tool_calls && !prev.tool_calls) {
                    prev.tool_calls = msg.tool_calls;
                }
                if (msg.reasoning_content && !prev.reasoning_content) {
                    prev.reasoning_content = msg.reasoning_content;
                }
                if (msg.thinking_blocks && !prev.thinking_blocks) {
                    prev.thinking_blocks = msg.thinking_blocks;
                }
                if (msg.thinking_signature && !prev.thinking_signature) {
                    prev.thinking_signature = msg.thinking_signature;
                }
                if (typeof msg.content === 'string' && msg.content) {
                    if (typeof prev.content === 'string' && prev.content) {
                        prev.content += '\n' + msg.content;
                    } else {
                        prev.content = msg.content;
                    }
                }
                continue;
            }

            result.push({ ...msg });
        }

        return result;
    }

    function formatMessages(messages) {
        if (!messages) return [];

        function mapContentParts(contentArray) {
            return contentArray.map(part => {
                if (part.type === 'thinking') {
                    return { type: 'thinking', thinking: part.thinking || '', ...(part.signature ? { signature: part.signature } : {}) };
                }
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
        }

        const result = [];
        for (const m of messages) {
            if (m.role === 'tool') {
                const toolResult = {
                    type: 'tool_result',
                    tool_use_id: m.tool_call_id || m.tool_use_id,
                    content: Array.isArray(m.content) ? mapContentParts(m.content).filter(Boolean) : (m.content || '')
                };
                const lastMsg = result[result.length - 1];
                if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content.some(c => c.type === 'tool_result')) {
                    lastMsg.content.push(toolResult);
                } else {
                    result.push({
                        role: 'user',
                        content: [toolResult]
                    });
                }
                continue;
            }

            if (Array.isArray(m.content)) {
                const content = mapContentParts(m.content).filter(Boolean);

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

                result.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
                continue;
            }

            const content = [];

            if (m.role === 'assistant' && m.thinking_blocks) {
                for (const block of m.thinking_blocks) {
                    content.push({ type: 'thinking', thinking: block.thinking || '', ...(block.signature ? { signature: block.signature } : {}) });
                }
            } else if (m.role === 'assistant' && m.reasoning_content) {
                content.push({ type: 'thinking', thinking: m.reasoning_content, ...(m.thinking_signature ? { signature: m.thinking_signature } : {}) });
            }

            if (m.content) {
                content.push({ type: 'text', text: String(m.content) });
            }

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
            
            result.push({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: content.length > 0 ? content : [{ type: 'text', text: '' }]
            });
        }
        return result;
    }

    function buildThinkingConfig(maxTokens) {
        const budget = Math.max(Math.floor(maxTokens * 0.8), 1024);
        return { type: 'enabled', budget_tokens: budget };
    }

    function hasThinkingInHistory(messages) {
        return messages.some(m =>
            m.role === 'assistant' &&
            (m.reasoning_content ||
             m.thinking_blocks ||
             (Array.isArray(m.content) && m.content.some(p => p.type === 'thinking')))
        );
    }

    function buildHeaders(apiKey) {
        return {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    function normalizeResponse(data, model) {
        let content = '';
        let reasoning_content = null;
        let thinking_blocks = null;
        let tool_calls = null;
        
        if (data.content && Array.isArray(data.content)) {
            const thinkingBlocks = data.content.filter(b => b.type === 'thinking');
            if (thinkingBlocks.length > 0) {
                reasoning_content = thinkingBlocks.map(b => b.thinking || '').join('');
                thinking_blocks = thinkingBlocks.map(b => ({
                    type: 'thinking',
                    thinking: b.thinking || '',
                    ...(b.signature ? { signature: b.signature } : {})
                }));
            }
            
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
        if (reasoning_content) {
            message.reasoning_content = reasoning_content;
        }
        if (thinking_blocks) {
            message.thinking_blocks = thinking_blocks;
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

            const { messages: rawMessages, systemPrompt } = extractSystemPrompt(request.messages);

            const messages = normalizeMessages(rawMessages);
            const formattedMessages = formatMessages(messages);
            const thinkingInHistory = hasThinkingInHistory(messages);

            const body = {
                model,
                messages: formattedMessages,
                max_tokens: request.maxTokens
            };

            if (request.enable_thinking != null) {
                body.thinking = request.enable_thinking
                    ? buildThinkingConfig(request.maxTokens)
                    : { type: 'disabled' };
            } else if (thinkingInHistory) {
                body.thinking = buildThinkingConfig(request.maxTokens);
            }

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

            logger.info('Non-stream request', {
                inputMessageCount: rawMessages.length,
                normalizedCount: messages.length,
                merged: rawMessages.length - messages.length,
                thinkingInHistory,
                thinkingConfig: body.thinking,
                assistantMessages: messages.filter(m => m.role === 'assistant').map(m => ({
                    hasReasoningContent: !!m.reasoning_content,
                    reasoningContentLength: m.reasoning_content?.length || 0,
                    hasToolCalls: !!m.tool_calls,
                    toolCallCount: m.tool_calls?.length || 0,
                    contentPreview: typeof m.content === 'string' ? m.content?.substring(0, 80) : '[array]'
                }))
            });

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

            const { messages: rawMessages, systemPrompt } = extractSystemPrompt(request.messages);

            const messages = normalizeMessages(rawMessages);
            const formattedMessages = formatMessages(messages);
            const thinkingInHistory = hasThinkingInHistory(messages);

            const body = {
                model,
                messages: formattedMessages,
                max_tokens: request.maxTokens,
                stream: true
            };

            if (request.enable_thinking != null) {
                body.thinking = request.enable_thinking
                    ? buildThinkingConfig(request.maxTokens)
                    : { type: 'disabled' };
            } else if (thinkingInHistory) {
                body.thinking = buildThinkingConfig(request.maxTokens);
            }

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

            logger.info('Stream request', {
                inputMessageCount: rawMessages.length,
                normalizedCount: messages.length,
                merged: rawMessages.length - messages.length,
                thinkingInHistory,
                thinkingConfig: body.thinking,
                assistantMessages: messages.filter(m => m.role === 'assistant').map(m => ({
                    hasReasoningContent: !!m.reasoning_content,
                    hasThinkingBlocks: !!m.thinking_blocks,
                    thinkingBlockSignatures: m.thinking_blocks?.map(b => b.signature?.substring(0, 30) || 'NONE'),
                    reasoningContentLength: m.reasoning_content?.length || 0,
                    hasContentArray: Array.isArray(m.content),
                    hasToolCalls: !!m.tool_calls,
                    toolCallCount: m.tool_calls?.length || 0,
                    contentPreview: typeof m.content === 'string' ? m.content?.substring(0, 80) : null
                })),
                formattedAssistantMessages: formattedMessages.filter(m => m.role === 'assistant').map(m => ({
                    contentBlockTypes: Array.isArray(m.content) ? m.content.map(b => b.type) : null,
                    thinkingSignatures: Array.isArray(m.content) ? m.content.filter(b => b.type === 'thinking').map(b => b.signature?.substring(0, 30) || 'NONE') : null
                }))
            });

            const res = await httpRequest(`${endpoint}/v1/messages`, {
                method: 'POST',
                headers: buildHeaders(apiKey),
                signal: request.signal,
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errorStr = await res.text();
                logger.error('Anthropic API Streaming Error', { status: res.status, body: errorStr }, 'AnthropicAdapter');
                throw new Error(`Anthropic API Streaming Error (${res.status}): ${errorStr}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const processId = `msg_${Date.now()}`;
            let inputTokens = 0;
            let outputTokens = 0;
            let thinkingSignature = null;
            let thinkingText = '';
            let loggedBlockStart = false;

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
                            if (event.type === 'error') {
                                logger.error('Anthropic stream emitted error event', { error: event.error }, 'AnthropicAdapter');
                                throw new Error(`Upstream API Stream Error: ${event.error?.message || JSON.stringify(event.error)}`);
                            }
                            if (event.type === 'message_start' && event.message?.usage) {
                                inputTokens = event.message.usage.input_tokens || 0;
                                if (event.message.content) {
                                    logger.info('Message start content blocks', {
                                        blockCount: event.message.content.length,
                                        blockTypes: event.message.content.map(b => b.type),
                                        thinkingSignature: event.message.content.find(b => b.type === 'thinking')?.signature?.substring(0, 40)
                                    });
                                }
                            }
                            if (event.type === 'content_block_stop') {
                                if (event.content_block?.type === 'thinking') {
                                    logger.info('Thinking block stop event', {
                                        hasContentBlock: !!event.content_block,
                                        signature: event.content_block?.signature?.substring(0, 40) || 'MISSING',
                                        thinkingLength: event.content_block?.thinking?.length || 0,
                                        allKeys: Object.keys(event.content_block || {})
                                    });
                                    if (event.content_block?.signature) {
                                        thinkingSignature = event.content_block.signature;
                                    }
                                }
                            }
                            if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
                                if (!loggedBlockStart) {
                                    logger.info('Thinking block start event', {
                                        contentBlockKeys: Object.keys(event.content_block || {}),
                                        hasSignature: !!event.content_block?.signature,
                                        signaturePreview: event.content_block?.signature?.substring(0, 40),
                                        fullBlock: JSON.stringify(event.content_block).substring(0, 200)
                                    });
                                    loggedBlockStart = true;
                                }
                                if (event.content_block?.signature) {
                                    thinkingSignature = event.content_block.signature;
                                }
                                yield {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    provider: 'anthropic',
                                    choices: [{
                                        index: 0,
                                        delta: { reasoning_content: '' },
                                        finish_reason: null
                                    }]
                                };
                            }
                            if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
                                yield {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    provider: 'anthropic',
                                    choices: [{
                                        index: 0,
                                        delta: { reasoning_content: event.delta.thinking || '' },
                                        finish_reason: null
                                    }]
                                };
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

                                // Emit finish_reason chunk (no usage — Copilot expects usage in a separate choices:[] chunk)
                                const finishChunk = {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    provider: 'anthropic',
                                    choices: [{
                                        index: 0,
                                        delta: {},
                                        finish_reason: finishReason || 'stop'
                                    }]
                                };
                                if (thinkingSignature) {
                                    finishChunk._thinking_signature = thinkingSignature;
                                }
                                yield finishChunk;

                                // Emit usage-only chunk in standard OpenAI format (choices: [])
                                yield {
                                    id: event.message?.id || processId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    provider: 'anthropic',
                                    choices: [],
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
