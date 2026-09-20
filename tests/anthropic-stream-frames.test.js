/**
 * Anthropic adapter — streaming frame vocabulary.
 *
 * The Anthropic protocol streams `content_block_*` frames whose `type` varies by
 * provider. The adapter maps a known subset and drops everything else, which is
 * correct at this boundary — the upstream is not ours to fix — but a dropped
 * frame is content that vanished, and until 2026-09-20 nothing recorded that it
 * had happened.
 *
 * These tests pin the two facts the kimi-k3 zero-content incident (issue #8)
 * turned on:
 *
 *   1. A stream whose only content block is an unmapped type produces no content
 *      at all — while still emitting a finish chunk. Left alone, that finish
 *      chunk flushes the SSE headers and the gateway is then indistinguishable
 *      from a model that answered with nothing.
 *   2. The drop is recorded, and the stream is reported as a failure over HTTP
 *      rather than presented as a completed empty turn.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import fs from 'node:fs/promises';
import path from 'node:path';
import EventEmitter from 'node:events';
import { createAdapters } from '../src/core/adapters.js';
import { StreamHandler } from '../src/streaming/sse.js';

class MockResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.body = '';
        this.writableEnded = false;
    }
    setHeader(k, v) { this.headers[k] = v; }
    flushHeaders() {}
    write(chunk) { this.body += chunk; return true; }
    end() { this.writableEnded = true; this.emit('close'); }
}

const MODEL = {
    type: 'chat',
    adapter: 'anthropic',
    adapterModel: 'kimi-k3',
    endpoint: 'https://upstream.invalid',
    apiKey: 'test-key',
    capabilities: { contextWindow: 200000, maxOutputTokens: 4096 }
};

const adapters = createAdapters();

/** Feed a canned SSE body through the real adapter over a stubbed fetch. */
function stubUpstream(events) {
    const frames = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const body = new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(frames));
                controller.close();
            }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => body;
    return () => { globalThis.fetch = realFetch; };
}

/** A stream that opens with `block` and closes normally — nothing else. */
const streamWithBlock = (block) => [
    { type: 'message_start', message: { id: 'msg_probe', usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' }
];

async function collect(events) {
    const restore = stubUpstream(events);
    try {
        const chunks = [];
        for await (const chunk of adapters.get('anthropic').streamComplete(MODEL, {
            messages: [{ role: 'user', content: 'hi' }],
            maxTokens: 64
        })) {
            chunks.push(chunk);
        }
        const text = (pick) => chunks.map(c => pick(c.choices?.[0]?.delta)).join('');
        return {
            chunks,
            content: text(d => d?.content ?? ''),
            reasoning: text(d => d?.reasoning_content ?? ''),
            finished: chunks.some(c => c.choices?.[0]?.finish_reason)
        };
    } finally {
        restore();
    }
}

describe('Anthropic adapter — streaming frames', function () {
    this.timeout(10000);

    it('a stream of only unmapped blocks yields no content but does finish', async () => {
        const result = await collect(streamWithBlock({ type: 'redacted_thinking', data: 'encrypted' }));

        expect(result.content).to.equal('');
        expect(result.reasoning).to.equal('');

        // The finish chunk is emitted regardless of content. It is the frame that
        // flushes SSE headers, which is why the zero-content path can no longer
        // answer with an HTTP error and has only the in-band route left.
        expect(result.finished).to.be.true;
    });

    it('records an unmapped content block instead of dropping it silently', async () => {
        const blockType = `probe_block_${Date.now()}`;
        await collect(streamWithBlock({ type: blockType }));

        // nLogger flushes its main log on a 1s timer.
        await new Promise(resolve => setTimeout(resolve, 1300));

        const mainLog = path.join(process.cwd(), 'tests', '_Test_Assets', 'logs', 'main-0.log');
        const logged = await fs.readFile(mainLog, 'utf8');

        expect(logged).to.include('unmapped content block dropped');
        expect(logged).to.include(blockType);
    });

    it('carries text delivered on content_block_start instead of losing it', async () => {
        const result = await collect(streamWithBlock({ type: 'text', text: 'Hello' }));
        expect(result.content).to.equal('Hello');
    });

    it('carries text deltas as content', async () => {
        const result = await collect([
            { type: 'message_start', message: { id: 'msg_probe', usage: { input_tokens: 100 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
            { type: 'message_stop' }
        ]);

        expect(result.content).to.equal('Hello');
        expect(result.finished).to.be.true;
    });
});

/**
 * The incident end to end: the real adapter feeding the real stream handler,
 * asserting what a consumer actually receives. This is the shape issue #8 is
 * about — and the shape a fix has to change.
 */
describe('Anthropic adapter → StreamHandler — the zero-content shape', function () {
    this.timeout(10000);

    it('answers a content-free upstream with an error instead of a false finish', async () => {
        const res = new MockResponse();
        const handler = new StreamHandler(res, { heartbeatIntervalMs: 100000 });
        const restore = stubUpstream(streamWithBlock({ type: 'redacted_thinking', data: 'encrypted' }));

        let caught;
        try {
            await handler.process(
                adapters.get('anthropic').streamComplete(MODEL, {
                    messages: [{ role: 'user', content: 'hi' }],
                    maxTokens: 64
                }),
                null,
                { model: 'kimi-k3-chat', adapter: 'anthropic' }
            );
        } catch (err) {
            caught = err;
        } finally {
            restore();
        }

        // The turn failed, and it says so. Nothing reached the wire, so the route
        // can still answer with an HTTP error status and a JSON body.
        expect(caught, 'zero content propagates to the route').to.exist;
        expect(caught.code).to.equal('ZERO_CONTENT');
        expect(res.headers['Content-Type']).to.be.undefined;
        expect(res.body).to.equal('');
        expect(res.body).to.not.include('[DONE]');
        expect(res.writableEnded).to.be.false;
    });

    it('holds pre-content frames and releases them in order once content arrives', async () => {
        const res = new MockResponse();
        const handler = new StreamHandler(res, { heartbeatIntervalMs: 100000 });

        async function* generator() {
            // A usage-bearing chunk with no choices, before any content. Sending it
            // would flush headers; it has to wait instead.
            yield { id: 'a', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, total_tokens: 1 } };
            yield { id: 'b', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
            yield { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] };
            yield { id: 'd', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        }

        await handler.process(generator(), null, { model: 'kimi-k3-chat', adapter: 'anthropic' });

        // Not dropped, and not reordered.
        const usageAt = res.body.indexOf('"prompt_tokens":1');
        const roleAt = res.body.indexOf('"role":"assistant"');
        const contentAt = res.body.indexOf('"content":"hi"');
        expect(usageAt).to.be.greaterThan(-1);
        expect(usageAt).to.be.lessThan(roleAt);
        expect(roleAt).to.be.lessThan(contentAt);
        expect(res.body).to.include('"finish_reason":"stop"');
        expect(res.body).to.include('data: [DONE]');
    });
});
