/**
 * Prior thinking on tool-call continuations.
 *
 * Providers declaring `capabilities.priorReasoning` require an assistant turn's
 * thinking to be echoed back by the next request. Clients do not round-trip it, so
 * the adapter supplies it from an id-keyed cache — and when neither the client's
 * echo nor the cache has it, the turn is not representable at all and the provider
 * refuses EVERY resend of that history:
 *
 *   HTTP 400 "The `content[].thinking` in the thinking mode must be passed back to
 *   the API" — deepseek-flash-chat, 2026-10-16, a session that could not continue.
 *
 * Probed live 2026-10-16: the requirement is structural, not semantic. A turn with
 * no thinking block is refused; an EMPTY block is accepted, on both DeepSeek and
 * Kimi. So an unrecoverable thinking goes back empty, and the loss is logged rather
 * than dressed up as real reasoning.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createAdapters } from '../src/core/adapters.js';

const adapters = createAdapters();

const model = (priorReasoning) => ({
    type: 'chat',
    adapter: 'anthropic',
    adapterModel: 'deepseek-flash',
    endpoint: 'https://upstream.invalid',
    apiKey: 'test-key',
    capabilities: { contextWindow: 200000, maxOutputTokens: 4096, ...(priorReasoning ? { priorReasoning } : {}) }
});

let realFetch = null;
function captureUpstream() {
    const sent = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ error: { message: 'captured' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' }
        });
    };
    return sent;
}

afterEach(() => {
    if (realFetch) {
        globalThis.fetch = realFetch;
        realFetch = null;
    }
});

async function send(modelConfig, messages) {
    const sent = captureUpstream();
    try {
        await adapters.get('anthropic').chatComplete(modelConfig, { messages, maxTokens: 64, stream: false });
    } catch { /* the stub rejects after the body is captured */ }
    return sent[0];
}

const TURN = [
    { role: 'user', content: 'Ping host a.' },
    {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ id: 'call_uncacheable_0001', type: 'function', function: { name: 'ping', arguments: '{"host":"a"}' } }]
    },
    { role: 'tool', tool_call_id: 'call_uncacheable_0001', content: 'pong' }
];

const blocksOf = (body, index) => body.messages[index].content;

describe('anthropic adapter — prior thinking on tool-call turns', () => {
    it('sends an empty thinking block when nothing can be recovered', async () => {
        // The 2026-10-16 session-killer: no client echo, no cache entry.
        const body = await send(model('required-with-tools'), TURN);

        const thinking = blocksOf(body, 1).filter(b => b.type === 'thinking');
        expect(thinking, 'the provider requires one; its absence is a 400').to.have.length(1);
        expect(thinking[0].thinking).to.equal('');
        // The call itself must survive — that is what the turn is for.
        expect(blocksOf(body, 1).some(b => b.type === 'tool_use')).to.be.true;
    });

    it('uses the client echo when the client sent one', async () => {
        const body = await send(model('required-with-tools'), [
            TURN[0],
            { ...TURN[1], reasoning_content: 'Weighing the ping.' },
            TURN[2]
        ]);

        const thinking = blocksOf(body, 1).filter(b => b.type === 'thinking');
        expect(thinking).to.have.length(1);
        expect(thinking[0].thinking).to.equal('Weighing the ping.');
    });

    it('adds no block when the model declares no such requirement', async () => {
        const body = await send(model(null), TURN);
        expect(blocksOf(body, 1).some(b => b.type === 'thinking')).to.be.false;
    });

    it('adds no block when the provider discards prior reasoning', async () => {
        const body = await send(model('ignored'), TURN);
        expect(blocksOf(body, 1).some(b => b.type === 'thinking')).to.be.false;
    });

    it('leaves a turn without tool calls alone', async () => {
        const body = await send(model('required-with-tools'), [
            { role: 'user', content: 'Ping host a.' },
            { role: 'assistant', content: 'Checking.' },
            { role: 'user', content: 'Continue.' }
        ]);
        const assistant = body.messages.find(m => m.role === 'assistant');
        expect(assistant.content.some(b => b.type === 'thinking')).to.be.false;
    });
});

describe('anthropic adapter — the trailing turn must carry thinking', () => {
    // Probed live 2026-10-16: a trailing assistant turn WITHOUT a thinking block is
    // a 400 ("The `content[].thinking` in the thinking mode must be passed back"),
    // one WITH it is accepted even empty, and a MID-history turn needs none.
    const TRAILING_PREFILL = [
        { role: 'user', content: 'Count to three.' },
        { role: 'assistant', content: 'One, two,' }
    ];

    it('leaves a mid-history turn without thinking untouched', async () => {
        const body = await send(model('required-with-tools'), [
            { role: 'user', content: 'Say hi.' },
            { role: 'assistant', content: 'Hi.' },
            { role: 'user', content: 'Now count.' }
        ]);
        const assistant = body.messages.find(m => m.role === 'assistant');

        expect(assistant.content.some(b => b.type === 'thinking'), 'not required there').to.be.false;
    });

    it('leaves the trailing turn alone for a model that declares no such requirement', async () => {
        const body = await send(model(null), TRAILING_PREFILL);
        const last = body.messages[body.messages.length - 1];

        expect(last.content.some(b => b.type === 'thinking')).to.be.false;
    });
});
