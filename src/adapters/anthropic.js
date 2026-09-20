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

// The streaming vocabulary this adapter maps. Anything outside these sets is
// dropped, and a drop must never be silent: a stream whose only content block is
// an unmapped type (e.g. `redacted_thinking`) yields nothing but the finish
// chunk, which is indistinguishable from a clean empty answer. That silence is
// what made the kimi-k3 "Stream produced zero content" incident of 2026-09-20
// (issue #8) undiagnosable — the raw frames were never recorded anywhere.
const MAPPED_EVENT_TYPES = new Set([
    'message_start', 'message_delta', 'message_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'ping', 'error'
]);
const MAPPED_CONTENT_BLOCKS = new Set(['text', 'thinking', 'tool_use']);
const MAPPED_DELTA_TYPES = new Set(['text_delta', 'thinking_delta', 'input_json_delta']);

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

// The outbound history must satisfy the upstream's structural rules. A stateless
// client resends its whole history on every turn, so a shape the upstream rejects
// fails on every retry and the session is dead until the client's own history
// changes. The gateway is the only party that can repair it, and repairing it is
// the difference between one bad turn and a lost conversation.
//
// The rules below were MEASURED, not assumed — scripts/probe-history-shapes.mjs
// sends each shape straight to the configured endpoints. Against DeepSeek's and
// Kimi's Anthropic endpoints (2026-09-19):
//
//   consecutive same-role messages .......... accepted by both (no alternation rule)
//   history starting with an assistant turn . accepted by both
//   empty content array ..................... DeepSeek 400, Kimi 200
//   empty text block ........................ DeepSeek 200, Kimi 400
//   duplicate tool_use id ................... 400 on both
//   tool_result with no matching tool_use ... 400 on both
//   tool_use whose result is missing from the
//     immediately following message (even last) 400 on both
//
// Two consequences shape this pass. Neither filler for an emptied message is legal
// on both providers ([] breaks DeepSeek, an empty text block breaks Kimi), so an
// emptied message is dropped — safe only because neither provider enforces role
// alternation. And tool pairing is mandatory in both directions, so every
// assistant turn is reconciled against the message immediately after it.
//
// Nothing is repaired silently: one WARN names everything that changed.
export function enforceHistoryInvariants(formatted) {
    const report = {
        emptyTextBlocks: 0,
        duplicateCallIds: [],
        reusedCallIds: [],
        idlessCallIds: 0,
        unansweredCalls: [],
        orphanResults: [],
        droppedMessages: 0
    };
    // What actually left the history. The WARN above reports counts, which is what
    // an incident needs; the blocks themselves are reported at debug, because a
    // repair changes what the model sees and that change has to be auditable
    // afterwards rather than taken on faith. Bounded — a broken history must not be
    // able to grow a log line without limit.
    const DROPPED_TRAIL_LIMIT = 20;
    const droppedTrail = [];
    const noteDropped = (reason, block) => {
        if (droppedTrail.length < DROPPED_TRAIL_LIMIT) droppedTrail.push({ reason, block });
    };
    const seenIds = new Set();

    const freshId = (base) => {
        let n = 2;
        let candidate = `${base}~gw${n}`;
        while (seenIds.has(candidate)) {
            n++;
            candidate = `${base}~gw${n}`;
        }
        return candidate;
    };

    // An empty text block is a 400 on Kimi, so it is never sent. Dropping it here
    // (rather than substituting something) is what keeps a message that has
    // nothing else in it empty, and empty messages are dropped below.
    const cleanBlocks = (content) => content.filter((block) => {
        if (block?.type === 'text' && (block.text ?? '') === '') {
            report.emptyTextBlocks++;
            noteDropped('emptyTextBlock', block);
            return false;
        }
        return true;
    });

    // Reconcile one assistant turn with the message immediately after it: ids are
    // made unique, then calls and results are paired, dropping what cannot pair.
    const reconcilePair = (blocks, nextBlocks) => {
        const remap = new Map();
        const inMessage = new Set();
        const kept = [];

        for (const block of blocks) {
            if (block?.type !== 'tool_use') {
                kept.push(block);
                continue;
            }
            if (typeof block.id !== 'string' || block.id.length === 0) {
                // No identity: nothing can pair with it, and inventing one would
                // not create the pairing. Sent as the client wrote it.
                report.idlessCallIds++;
                kept.push(block);
                continue;
            }
            if (inMessage.has(block.id)) {
                // Second time in the same turn. The result that follows can only
                // pair with one call, so the repeat is not representable.
                report.duplicateCallIds.push(block.id);
                noteDropped('duplicateCall', block);
                continue;
            }
            inMessage.add(block.id);

            if (seenIds.has(block.id)) {
                // The same id in an earlier turn: this is a different call wearing
                // a used id, so it is re-issued. Only this pair's results are
                // rewritten — a result belongs to the message next to its call.
                const newId = freshId(block.id);
                seenIds.add(newId);
                inMessage.add(newId);
                remap.set(block.id, newId);
                report.reusedCallIds.push({ from: block.id, to: newId });
                kept.push({ ...block, id: newId });
                continue;
            }

            seenIds.add(block.id);
            kept.push(block);
        }

        if (!nextBlocks) {
            const finalBlocks = kept.filter((block) => {
                if (block?.type !== 'tool_use') return true;
                report.unansweredCalls.push(block.id);
                noteDropped('unansweredCall', block);
                return false;
            });
            return { blocks: finalBlocks, nextBlocks: null };
        }

        const results = nextBlocks.map((block) => {
            if (block?.type !== 'tool_result') return block;
            if (typeof block.tool_use_id === 'string' && remap.has(block.tool_use_id)) {
                return { ...block, tool_use_id: remap.get(block.tool_use_id) };
            }
            return block;
        });

        const paired = new Set();
        const callIds = kept.filter(b => b?.type === 'tool_use').map(b => b.id);
        const resultIds = new Set(results.filter(b => b?.type === 'tool_result').map(b => b.tool_use_id));
        for (const id of callIds) {
            if (resultIds.has(id)) paired.add(id);
        }

        const finalBlocks = kept.filter((block) => {
            if (block?.type !== 'tool_use') return true;
            if (paired.has(block.id)) return true;
            report.unansweredCalls.push(block.id);
            noteDropped('unansweredCall', block);
            return false;
        });

        const finalResults = results.filter((block) => {
            if (block?.type !== 'tool_result') return true;
            if (block.tool_use_id != null && paired.has(block.tool_use_id)) return true;
            // A result must sit in the message immediately after its call, so an
            // unpaired one here can no longer be attached to anything.
            report.orphanResults.push(block.tool_use_id ?? null);
            noteDropped('orphanResult', block);
            return false;
        });

        return { blocks: finalBlocks, nextBlocks: finalResults };
    };

    const out = [];
    for (let i = 0; i < formatted.length; i++) {
        const msg = formatted[i];
        if (!Array.isArray(msg.content)) {
            out.push(msg);
            continue;
        }

        if (msg.role !== 'assistant') {
            // Not consumed as the second half of a pair, so any tool_result here
            // has no call immediately before it — it cannot be attached to one.
            const kept = cleanBlocks(msg.content).filter((block) => {
                if (block?.type !== 'tool_result') return true;
                report.orphanResults.push(block.tool_use_id ?? null);
                noteDropped('orphanResult', block);
                return false;
            });
            if (kept.length > 0) out.push({ ...msg, content: kept });
            else report.droppedMessages++;
            continue;
        }

        const next = formatted[i + 1];
        const nextHasResults = next?.role !== 'assistant'
            && Array.isArray(next?.content)
            && next.content.some(block => block?.type === 'tool_result');
        const nextBlocks = nextHasResults ? cleanBlocks(next.content) : null;

        const reconciled = reconcilePair(cleanBlocks(msg.content), nextBlocks);

        if (reconciled.blocks.length > 0) out.push({ ...msg, content: reconciled.blocks });
        else report.droppedMessages++;

        if (nextHasResults) {
            if (reconciled.nextBlocks.length > 0) out.push({ ...next, content: reconciled.nextBlocks });
            else report.droppedMessages++;
            i++;
        }
    }

    if (out.length === 0) {
        // Every message was empty. There is no request to make, and the caller
        // can see why — this is the one repair failure that is the caller's input.
        const err = new Error('[AnthropicAdapter] Request contained no sendable messages');
        err.status = 400;
        err.type = 'invalid_request_error';
        err.code = 'EMPTY_HISTORY';
        throw err;
    }

    const { emptyTextBlocks, duplicateCallIds, reusedCallIds, idlessCallIds, unansweredCalls, orphanResults, droppedMessages } = report;
    const changed = emptyTextBlocks > 0 || duplicateCallIds.length > 0 || reusedCallIds.length > 0
        || idlessCallIds > 0 || unansweredCalls.length > 0 || orphanResults.length > 0;
    if (changed) {
        logger.warn('Repaired outbound history to satisfy upstream rules', {
            emptyTextBlocks,
            duplicateCallIds,
            reusedCallIds,
            toolUseWithoutId: idlessCallIds,
            unansweredCalls,
            orphanResults,
            droppedMessages,
            messageCount: formatted.length,
            sentMessages: out.length
        }, 'AnthropicAdapter');
        logger.debug('Dropped from outbound history', {
            dropped: droppedTrail,
            trailTruncated: report.emptyTextBlocks + report.duplicateCallIds.length
                + report.unansweredCalls.length + report.orphanResults.length > droppedTrail.length
        }, 'AnthropicAdapter');
    }

    return out;
}

// A prompt that fills the window plus a large output budget is rejected as a whole:
// "This model's maximum context length is 1048576 tokens. However, you requested
// 1048626 tokens (664626 in the messages, 384000 in the completion)." The request
// overshoots by 50 tokens and a stateless client resends it unchanged forever, so
// the session dies on an arithmetic detail rather than on anything the user did.
//
// The rejection names both numbers the upstream used, so no token estimate is
// involved: the output budget becomes whatever the window has left. Headroom
// absorbs any difference between the upstream's count and the one it reports.
const OUTPUT_BUDGET_HEADROOM = 64;

export function parseContextOverflow(message) {
    if (typeof message !== 'string') return null;
    const match = message.match(
        /maximum context length is (\d+) tokens[\s\S]*?\((\d+) in the messages,\s*(\d+) in the completion\)/i
    );
    if (!match) return null;
    return {
        contextWindow: Number(match[1]),
        promptTokens: Number(match[2]),
        requestedCompletion: Number(match[3])
    };
}

/**
 * Send a Messages request, and if the upstream rejects it for exceeding the context
 * window, shrink the output budget to what fits and send it once more.
 *
 * `send` is injected so the retry can be tested without a live upstream.
 * Only a context-length rejection is retried, and only once.
 */
export async function sendWithBudgetRetry(send, body) {
    try {
        return await send(body);
    } catch (error) {
        const overflow = parseContextOverflow(error?.message);
        if (!overflow) throw error;

        const remaining = overflow.contextWindow - overflow.promptTokens - OUTPUT_BUDGET_HEADROOM;
        if (remaining < 1) {
            // The prompt alone fills the window: there is no budget to give and
            // nothing to retry with. The original error is the honest answer.
            throw error;
        }

        body.max_tokens = remaining;
        // Anthropic requires the thinking budget to stay under max_tokens, so a
        // shrunk budget would otherwise be rejected on a different rule.
        if (typeof body.thinking?.budget_tokens === 'number' && body.thinking.budget_tokens >= remaining) {
            body.thinking.budget_tokens = Math.max(1, remaining - 1);
        }

        logger.warn('Upstream rejected the request for exceeding its context window — retrying with a reduced output budget', {
            contextWindow: overflow.contextWindow,
            promptTokens: overflow.promptTokens,
            requestedCompletion: overflow.requestedCompletion,
            retryMaxTokens: body.max_tokens
        }, 'AnthropicAdapter');

        return send(body);
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
                if (msg.tool_calls) {
                    // Two assistant turns in a row is a client-side artifact (a
                    // retry, a variant, or a split turn). Keep every call: the
                    // tool results that follow reference them by id, and dropping
                    // any orphans a result downstream. Repeated ids are repaired
                    // in enforceHistoryInvariants below.
                    const merged = [...(prev.tool_calls || [])];
                    const seenIds = new Set(merged.map(tc => tc.id));
                    for (const tc of msg.tool_calls) {
                        if (seenIds.has(tc.id)) continue;
                        seenIds.add(tc.id);
                        merged.push(tc);
                    }
                    prev.tool_calls = merged;
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

    async function formatMessages(messages, capabilities) {
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
                // Prior-reasoning policy (2026-08-29, see provider docs):
                // - 'ignored' → strip (provider discards it; pure token waste).
                // - signed → emit with signature (Anthropic thinking-block contract).
                // - unsigned on NATIVE Anthropic (anthropicVersion set) → DROP + warn:
                //   an unsigned thinking block in echoed history 400s during tool
                //   use (the chat-app's former global strip was this guard, but it
                //   also stripped providers that REQUIRE reasoning — moved here where
                //   the provider is known).
                // - unsigned on third-party anthropic-protocol providers (Kimi etc.,
                //   no anthropicVersion) → keep: Kimi requires the echo.
                if (capabilities?.priorReasoning !== 'ignored') {
                    if (m.thinking_signature) {
                        content.push({ type: 'thinking', thinking: m.reasoning_content, signature: m.thinking_signature });
                    } else if (capabilities?.anthropicVersion) {
                        logger.warn('Dropping unsigned reasoning_content (would 400 on tool-use continuation)', {}, 'AnthropicAdapter');
                    } else {
                        content.push({ type: 'thinking', thinking: m.reasoning_content });
                    }
                }
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
                // Left possibly empty: an emptied message is dropped by
                // enforceHistoryInvariants. Substituting an empty text block here
                // would be a 400 on Kimi, and [] a 400 on DeepSeek.
                content
            });
        }

        return enforceHistoryInvariants(result);
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
            const formattedMessages = await formatMessages(messages, capabilities);

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

            const res = await sendWithBudgetRetry(
                (payload) => httpRequest(`${endpoint}/v1/messages`, {
                    method: 'POST',
                    headers: buildHeaders(apiKey, capabilities),
                    signal: request.signal,
                    body: JSON.stringify(payload)
                }),
                body
            );

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
            const formattedMessages = await formatMessages(messages, capabilities);

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

            const res = await sendWithBudgetRetry(
                (payload) => httpRequest(`${endpoint}/v1/messages`, {
                    method: 'POST',
                    headers: buildHeaders(apiKey, capabilities),
                    signal: request.signal,
                    body: JSON.stringify(payload)
                }),
                body
            );

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

                        // Tolerance is allowed at this boundary (the upstream is not
                        // ours to fix), but it leaves a trace. Without these three
                        // warnings an unmapped frame is simply content that vanished.
                        if (!MAPPED_EVENT_TYPES.has(event.type)) {
                            logger.warn('Anthropic stream: unmapped event dropped', {
                                eventType: event.type,
                                keys: Object.keys(event)
                            }, 'AnthropicAdapter');
                        }
                        if (event.type === 'content_block_start'
                            && event.content_block
                            && !MAPPED_CONTENT_BLOCKS.has(event.content_block.type)) {
                            logger.warn('Anthropic stream: unmapped content block dropped', {
                                blockType: event.content_block.type,
                                index: event.index,
                                blockKeys: Object.keys(event.content_block)
                            }, 'AnthropicAdapter');
                        }
                        if (event.type === 'content_block_delta'
                            && event.delta?.type
                            && !MAPPED_DELTA_TYPES.has(event.delta.type)) {
                            logger.warn('Anthropic stream: unmapped delta dropped', {
                                deltaType: event.delta.type,
                                index: event.index,
                                deltaKeys: Object.keys(event.delta)
                            }, 'AnthropicAdapter');
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
                        // Spec says a text block opens with an empty string and the
                        // words arrive as `text_delta`. A provider that inlines the
                        // text here would otherwise lose it — carry it through, and
                        // say so, because it is a departure from the spec.
                        if (event.type === 'content_block_start'
                            && event.content_block?.type === 'text'
                            && event.content_block.text) {
                            logger.warn('Anthropic stream: text carried on content_block_start, not deltas', {
                                index: event.index,
                                length: event.content_block.text.length
                            }, 'AnthropicAdapter');
                            yield {
                                id: event.message?.id || processId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                provider: 'anthropic',
                                choices: [{
                                    index: 0,
                                    delta: { content: event.content_block.text },
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
            const formatted = await formatMessages(normalized, capabilities);

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
