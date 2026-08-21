/**
 * Anthropic Adapter - Protocol handler for Anthropic-compatible APIs.
 * Stateless - model config passed per-request.
 * Supports: Anthropic Claude, MiniMax, Qwen (Anthropic mode)
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { request as httpRequest, readWithDeadline } from '../utils/http.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('AnthropicAdapter');

// Tool-call thinking round-trip cache.
//
// DeepSeek (Anthropic-protocol) requires the prior assistant turn's `thinking`
// content block to be echoed back on tool-call continuations, otherwise the
// upstream rejects with 400 "The `content[].thinking` in the thinking mode
// must be passed back to the API." The gateway is stateless and clients do not
// reliably round-trip thinking parts, so each tool_use's preceding thinking
// block (text + signature) is cached keyed by the tool_use id and re-injected
// on the next turn. Mirrors the Gemini adapter's thought-signature cache.
const THINKING_CACHE_DIR = path.join(process.cwd(), 'logs', 'anthropic-thinking');
const memoryThinkingBlocks = new Map();
let thinkingCachePruned = false;

async function ensureThinkingCacheDir() {
    try {
        if (!existsSync(THINKING_CACHE_DIR)) {
            await fs.mkdir(THINKING_CACHE_DIR, { recursive: true });
        }
    } catch (e) {
        logger.error(`Failed to create anthropic thinking cache dir: ${e.message}`, {}, 'AnthropicAdapter');
    }
}

async function saveThinkingBlock(toolUseId, block) {
    if (!toolUseId || !block) return;
    memoryThinkingBlocks.set(toolUseId, block);
    await ensureThinkingCacheDir();
    const filePath = path.join(THINKING_CACHE_DIR, `${toolUseId}.json`);
    try {
        await fs.writeFile(filePath, JSON.stringify(block), 'utf8');
    } catch (e) {
        logger.error(`Failed to save thinking block for ${toolUseId}: ${e.message}`, {}, 'AnthropicAdapter');
    }
}

async function getThinkingBlock(toolUseId) {
    if (!toolUseId) return null;
    if (memoryThinkingBlocks.has(toolUseId)) return memoryThinkingBlocks.get(toolUseId);
    const filePath = path.join(THINKING_CACHE_DIR, `${toolUseId}.json`);
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const block = JSON.parse(raw);
        memoryThinkingBlocks.set(toolUseId, block);
        return block;
    } catch {
        return null;
    }
}

async function pruneThinkingCache() {
    if (thinkingCachePruned) return;
    thinkingCachePruned = true;
    await ensureThinkingCacheDir();
    try {
        const files = await fs.readdir(THINKING_CACHE_DIR);
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let pruned = 0;
        for (const file of files) {
            const filePath = path.join(THINKING_CACHE_DIR, file);
            try {
                const stat = await fs.stat(filePath);
                if (stat.mtimeMs < cutoff) {
                    await fs.unlink(filePath);
                    pruned++;
                }
            } catch {
                // Individual file errors (races, missing file) are non-fatal.
            }
        }
        if (pruned > 0) logger.info(`Pruned ${pruned} stale anthropic thinking blocks`, {}, 'AnthropicAdapter');
    } catch {
        // Cache pruning is best-effort; a failure must not affect requests.
    }
}

export function createAnthropicAdapter() {
    pruneThinkingCache().catch(() => {});
    function parseArguments(args) {
        if (typeof args === 'string') {
            try { return JSON.parse(args); } catch {
                // Fail loud: a malformed tool-call arguments string must not
                // silently become {} — the tool would receive wrong input.
                throw new Error(`[AnthropicAdapter] Malformed tool-call arguments JSON: ${args.slice(0, 120)}`);
            }
        }
        if (args == null) {
            throw new Error('[AnthropicAdapter] Tool-call arguments missing (null/undefined)');
        }
        return args;
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

    async function formatMessages(messages) {
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

        // Re-inject the cached thinking block ahead of tool_use blocks when the
        // client did not supply one. DeepSeek requires the prior turn's thinking
        // block to be echoed back on tool-call continuations.
        async function injectCachedThinking(content, toolCalls) {
            if (content.some(c => c.type === 'thinking')) return content;
            for (const tc of toolCalls || []) {
                const cached = await getThinkingBlock(tc.id);
                if (cached && (cached.thinking || cached.signature)) {
                    const block = { type: 'thinking', thinking: cached.thinking || '' };
                    if (cached.signature) block.signature = cached.signature;
                    return [block, ...content];
                }
            }
            return content;
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
                let content = mapContentParts(m.content).filter(Boolean);

                if (m.role === 'assistant' && m.tool_calls) {
                    content = await injectCachedThinking(content, m.tool_calls);
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

            let content = [];

            if (m.role === 'assistant' && m.thinking_blocks) {
                for (const block of m.thinking_blocks) {
                    content.push({ type: 'thinking', thinking: block.thinking || '', ...(block.signature ? { signature: block.signature } : {}) });
                }
            } else if (m.role === 'assistant' && m.reasoning_content) {
                content.push({ type: 'thinking', thinking: m.reasoning_content, ...(m.thinking_signature ? { signature: m.thinking_signature } : {}) });
            }

            if (m.role === 'assistant' && m.tool_calls) {
                content = await injectCachedThinking(content, m.tool_calls);
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

    function buildThinkingConfig(maxTokens, capabilities) {
        // Opus 4.7/4.8 use adaptive thinking (model decides when to think)
        if (capabilities?.thinkingMode === 'adaptive') {
            return { type: 'adaptive' };
        }
        if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
            throw new Error('[AnthropicAdapter] thinking budget requires a finite maxTokens — declare capabilities.maxOutputTokens or send max_tokens');
        }
        const budget = Math.max(Math.floor(maxTokens * 0.8), 1024);
        return { type: 'enabled', budget_tokens: budget };
    }

    // Effort → native Anthropic control. Models that declare thinkingEffort
    // use the behavioral output_config.effort field (low/medium/high/max);
    // 'none' disables. Models without the declaration keep the budget path.
    function applyThinking(body, request, maxTokens, capabilities, messages) {
        const effort = request.reasoning_effort;
        if (effort != null && capabilities?.thinkingEffort) {
            if (effort === 'none' || effort === 'off') {
                if (capabilities?.thinkingMode !== 'adaptive') {
                    body.thinking = { type: 'disabled' };
                }
            } else {
                // Clamp to the Anthropic effort enum; value already validated
                // against declared thinkingLevels at the router.
                const effortMap = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max' };
                body.output_config = { effort: effortMap[effort] || effort };
            }
            return;
        }

        if (request.enable_thinking != null) {
            if (request.enable_thinking) {
                body.thinking = buildThinkingConfig(maxTokens, capabilities);
            } else if (capabilities?.thinkingMode !== 'adaptive') {
                // Adaptive-only models (e.g. Fable 5) reject thinking.type.disabled;
                // omitting the field entirely gives their default adaptive behavior.
                body.thinking = { type: 'disabled' };
            }
        } else if (hasThinkingInHistory(messages)) {
            body.thinking = buildThinkingConfig(maxTokens, capabilities);
        }
    }

    function hasThinkingInHistory(messages) {
        return messages.some(m =>
            m.role === 'assistant' &&
            (m.reasoning_content ||
             m.thinking_blocks ||
             (Array.isArray(m.content) && m.content.some(p => p.type === 'thinking')))
        );
    }

    function buildHeaders(apiKey, capabilities) {
        const headers = { 'Content-Type': 'application/json' };
        // Native Anthropic uses x-api-key; third-party Anthropic-protocol providers use Bearer
        if (capabilities?.anthropicVersion) {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = capabilities.anthropicVersion;
        } else {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        return headers;
    }

    // Prompt caching: explicit client breakpoints always win. When the model
    // declares capabilities.promptCaching and the client sent nothing, inject
    // top-level automatic caching — Anthropic then caches the growing prefix
    // (tools → system → messages) with zero breakpoint management.
    function resolveCacheControl(request, capabilities) {
        if (request.cache_control) return request.cache_control;
        const pc = capabilities?.promptCaching;
        if (!pc) return undefined;
        const cc = { type: 'ephemeral' };
        if (pc === '1h') cc.ttl = '1h';
        return cc;
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
                total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
                cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
                cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0
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
            const model = adapterModel;

            if (!apiKey) {
                throw new Error('[AnthropicAdapter] apiKey is required in modelConfig');
            }

            const { messages: rawMessages, systemPrompt: extractedSystem } = extractSystemPrompt(request.messages);
            const systemPrompt = extractedSystem ?? request.systemPrompt;

            const messages = normalizeMessages(rawMessages);
            const formattedMessages = await formatMessages(messages);

            const body = {
                model,
                messages: formattedMessages,
                max_tokens: request.maxTokens
            };

            applyThinking(body, request, request.maxTokens, capabilities, messages);

            if (systemPrompt) body.system = systemPrompt;
            if (typeof request.temperature === 'number') {
                // Anthropic: temperature must be 1 when thinking is enabled (non-disabled)
                const thinkingActive = body.thinking && body.thinking.type !== 'disabled';
                if (!thinkingActive || request.temperature === 1) {
                    body.temperature = request.temperature;
                }
            }

            // Prompt caching: explicit client value wins, else auto-inject
            // top-level automatic caching for models that declare support.
            const cacheControl = resolveCacheControl(request, capabilities);
            if (cacheControl) body.cache_control = cacheControl;

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

            // Strip parameters the model doesn't support (e.g. reasoning models reject temperature)
            const excludeParams = modelConfig?.capabilities?.excludeParams;
            if (Array.isArray(excludeParams)) {
                for (const key of excludeParams) {
                    delete body[key];
                }
            }

            const res = await httpRequest(`${endpoint}/v1/messages`, {
                method: 'POST',
                headers: buildHeaders(apiKey, capabilities),
                signal: request.signal,
                body: JSON.stringify(body)
            });

            const data = await res.json();

            if (data.content && Array.isArray(data.content)) {
                const thinkingBlocks = data.content.filter(b => b.type === 'thinking');
                const toolUses = data.content.filter(b => b.type === 'tool_use');
                if (thinkingBlocks.length > 0 && toolUses.length > 0) {
                    const thinking = thinkingBlocks.map(b => b.thinking || '').join('');
                    const signature = thinkingBlocks[thinkingBlocks.length - 1].signature || null;
                    for (const tu of toolUses) {
                        await saveThinkingBlock(tu.id, { thinking, signature });
                    }
                }
            }

            if (data.error) {
                throw new Error(`Anthropic API Error: ${data.error.message}`);
            }

            return normalizeResponse(data, model);
        },

        async *streamComplete(modelConfig, request) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            const model = adapterModel;

            if (!apiKey) {
                throw new Error('[AnthropicAdapter] apiKey is required in modelConfig');
            }

            const { messages: rawMessages, systemPrompt: extractedSystem } = extractSystemPrompt(request.messages);
            const systemPrompt = extractedSystem ?? request.systemPrompt;

            const messages = normalizeMessages(rawMessages);
            const formattedMessages = await formatMessages(messages);

            const body = {
                model,
                messages: formattedMessages,
                max_tokens: request.maxTokens,
                stream: true
            };

            applyThinking(body, request, request.maxTokens, capabilities, messages);

            if (systemPrompt) body.system = systemPrompt;
            if (typeof request.temperature === 'number') {
                // Anthropic: temperature must be 1 when thinking is enabled (non-disabled)
                const thinkingActive = body.thinking && body.thinking.type !== 'disabled';
                if (!thinkingActive || request.temperature === 1) {
                    body.temperature = request.temperature;
                }
            }

            // Prompt caching: explicit client value wins, else auto-inject
            // top-level automatic caching for models that declare support.
            const cacheControl = resolveCacheControl(request, capabilities);
            if (cacheControl) body.cache_control = cacheControl;

            // Tools conversion
            if (request.tools) {
                const { claudeTools, claudeToolChoice } = convertToolsFormat(request.tools, request.tool_choice);
                if (claudeTools && claudeTools.length > 0) {
                    body.tools = claudeTools;
                    if (claudeToolChoice) body.tool_choice = claudeToolChoice;
                }
            }

            // Strip parameters the model doesn't support (e.g. reasoning models reject temperature)
            const excludeParams = modelConfig?.capabilities?.excludeParams;
            if (Array.isArray(excludeParams)) {
                for (const key of excludeParams) {
                    delete body[key];
                }
            }

            const res = await httpRequest(`${endpoint}/v1/messages`, {
                method: 'POST',
                headers: buildHeaders(apiKey, capabilities),
                signal: request.signal,
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errorStr = await res.text();
                logger.error('Anthropic API Streaming Error', null, { status: res.status, body: errorStr }, 'AnthropicAdapter');
                throw new Error(`Anthropic API Streaming Error (${res.status}): ${errorStr}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const processId = `msg_${Date.now()}`;
            let inputTokens = 0;
            let outputTokens = 0;
            let cacheReadTokens = 0;
            let cacheCreationTokens = 0;
            let thinkingSignature = null;
            let thinkingText = '';
            const toolUseIds = [];

            try {
                while (true) {
                    const { done, value } = await readWithDeadline(reader);
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        // Standard Anthropic: "data: {...}" (space after colon)
                        // Kimi Coding API:   "data:{...}"  (no space)
                        let data;
                        if (line.startsWith('data: ')) {
                            data = line.slice(6);
                        } else if (line.startsWith('data:')) {
                            data = line.slice(5);
                        } else {
                            continue;
                        }
                        if (data === '[DONE]') continue;

                        // Parse the SSE frame outside the dispatch so a malformed
                        // frame is tolerated but a real error is never swallowed.
                        let event;
                        try {
                            event = JSON.parse(data);
                        } catch {
                            logger.warn('Anthropic stream: skipping unparseable SSE frame', { preview: data.slice(0, 160) }, 'AnthropicAdapter');
                            continue;
                        }

                        if (event.type === 'error') {
                            logger.error('Anthropic stream emitted error event', null, { error: event.error }, 'AnthropicAdapter');
                            throw new Error(`Upstream API Stream Error: ${event.error?.message || JSON.stringify(event.error)}`);
                        }
                        if (event.type === 'message_start' && event.message?.usage) {
                            const u = event.message.usage;
                            inputTokens = u.input_tokens || 0;
                            cacheReadTokens = u.cache_read_input_tokens || 0;
                            cacheCreationTokens = u.cache_creation_input_tokens || 0;
                        }
                        if (event.type === 'content_block_stop') {
                            if (event.content_block?.type === 'thinking') {
                                if (event.content_block?.signature) {
                                    thinkingSignature = event.content_block.signature;
                                }
                            }
                        }
                        if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
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
                            thinkingText += event.delta.thinking || '';
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
                            toolUseIds.push(event.content_block.id);
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

                            if (finishReason === 'tool_calls' && (thinkingText || thinkingSignature)) {
                                for (const id of toolUseIds) {
                                    await saveThinkingBlock(id, { thinking: thinkingText, signature: thinkingSignature || null });
                                }
                            }

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
                                    total_tokens: inputTokens + outputTokens,
                                    cache_read_input_tokens: cacheReadTokens,
                                    cache_creation_input_tokens: cacheCreationTokens
                                }
                            };
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

        async listModels(modelConfig) {
            const { endpoint, apiKey, capabilities } = modelConfig;
            const contextWindow = capabilities?.contextWindow;

            // buildHeaders sends x-api-key + anthropic-version for native Anthropic,
            // Bearer for third-party Anthropic-protocol providers. The previous
            // hardcoded Bearer 401'd against the native endpoint, and the catch
            // below then returned a fabricated model list as truth.
            const res = await httpRequest(`${endpoint}/v1/models`, {
                headers: buildHeaders(apiKey, capabilities)
            });
            const data = await res.json();

            if (!Array.isArray(data.data)) {
                throw new Error('[AnthropicAdapter] /v1/models returned no data array');
            }

            return data.data.map(m => ({
                id: m.id,
                object: 'model',
                owned_by: 'anthropic',
                capabilities: {
                    chat: true,
                    vision: m.vision !== false && (m.id.includes('claude-3') || m.id.includes('vision')),
                    structured_output: true,
                    streaming: true,
                    context_window: m.context_window ?? contextWindow
                }
            }));
        },

        /**
         * Native token counting via the Anthropic count_tokens endpoint.
         * Used by the model router for accurate context window display.
         */
        async countMessageTokens(messages, modelConfig) {
            const { endpoint, apiKey, adapterModel, capabilities } = modelConfig;
            const model = adapterModel;

            const { messages: rawMessages, systemPrompt } = extractSystemPrompt(messages);
            const normalized = normalizeMessages(rawMessages);
            const formatted = formatMessages(normalized);

            const body = { model, messages: formatted };
            if (systemPrompt) body.system = systemPrompt;

            try {
                const res = await httpRequest(`${endpoint}/v1/messages/count_tokens`, {
                    method: 'POST',
                    headers: buildHeaders(apiKey, capabilities),
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                if (typeof data.input_tokens === 'number') {
                    return data.input_tokens;
                }
                logger.warn('count_tokens returned unexpected format', { keys: Object.keys(data), input_tokens: data.input_tokens }, 'AnthropicAdapter');
            } catch (err) {
                logger.warn('count_tokens failed, falling back to estimator', {
                    error: err.message,
                    messageCount: messages?.length,
                    hasTools: messages?.some(m => m.role === 'tool' || m.tool_calls)
                }, 'AnthropicAdapter');
            }
            return null;
        }
    };
}
