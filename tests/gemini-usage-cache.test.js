/**
 * Gemini adapter — implicit cache hits are reported to the caller.
 *
 * The Interactions API reports cache hits in `usage.total_cached_tokens`, which
 * the adapter used to drop: a caller could not tell whether a repeated prefix
 * was served from cache or billed at full price. Implicit caching is
 * best-effort (verified live 2026-10-13: identical requests seconds apart
 * missed entirely, the same pair ten seconds apart hit for 2,193 of 4,242
 * input tokens) and — contrary to what "stateful" would suggest — it works with
 * `store: false`, so this is the only visibility a caller gets.
 *
 * The gateway's convention for this number is `prompt_tokens_details.cached_tokens`
 * (see src/utils/response-format.js, and the anthropic adapter's
 * `cache_read_input_tokens`).
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createAdapters } from '../src/core/adapters.js';

const adapters = createAdapters();
let realFetch = null;

afterEach(() => {
    if (realFetch) {
        globalThis.fetch = realFetch;
        realFetch = null;
    }
});

const MODEL = {
    type: 'chat',
    adapter: 'gemini',
    adapterModel: 'gemini-4-argon',
    endpoint: 'https://upstream.invalid/v1beta',
    apiKey: 'test-key',
    capabilities: { contextWindow: 1048576, maxOutputTokens: 65536 }
};

function stubJson(payload) {
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function stubStream(events) {
    const body = events
        .map(e => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join('');
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
    });
}

const USAGE = {
    total_input_tokens: 4242,
    total_output_tokens: 5,
    total_tokens: 4247,
    total_cached_tokens: 2193
};

describe('Gemini adapter — cache hit reporting', () => {
    it('non-streaming: reports cached input tokens alongside the prompt count', async () => {
        stubJson({
            id: 'int_1',
            status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }],
            usage: USAGE
        });

        const result = await adapters.get('gemini').chatComplete(MODEL, {
            messages: [{ role: 'user', content: 'hi' }]
        });

        expect(result.usage.prompt_tokens).to.equal(4242);
        expect(result.usage.prompt_tokens_details.cached_tokens).to.equal(2193);
    });

    it('streaming: reports cached input tokens in the usage chunk', async () => {
        stubStream([
            { event_type: 'interaction.created', interaction: { id: 'int_1', status: 'in_progress' } },
            { event_type: 'step.start', step: { type: 'model_output' } },
            { event_type: 'step.delta', delta: { type: 'text', text: 'ok' } },
            { event_type: 'step.stop' },
            { event_type: 'interaction.completed', interaction: { id: 'int_1', status: 'completed', usage: USAGE } }
        ]);

        const chunks = [];
        for await (const chunk of adapters.get('gemini').streamComplete(MODEL, {
            messages: [{ role: 'user', content: 'hi' }]
        })) chunks.push(chunk);

        const usageChunk = chunks.find(c => c.usage);
        expect(usageChunk.usage.prompt_tokens).to.equal(4242);
        expect(usageChunk.usage.prompt_tokens_details.cached_tokens).to.equal(2193);
    });

    it('reports zero rather than omitting the field when nothing was cached', async () => {
        stubJson({
            id: 'int_1',
            status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }],
            usage: { ...USAGE, total_cached_tokens: 0 }
        });

        const result = await adapters.get('gemini').chatComplete(MODEL, {
            messages: [{ role: 'user', content: 'hi' }]
        });

        expect(result.usage.prompt_tokens_details).to.deep.equal({ cached_tokens: 0 });
    });
});
