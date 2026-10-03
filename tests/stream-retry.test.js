import { expect } from 'chai';
import EventEmitter from 'node:events';
import { createChatHandler } from '../src/routes/chat.js';

// Shared/free endpoints fail in bursts: a 200 SSE stream carrying an error
// frame, or a stream that ends without emitting anything at all. sse.js withholds
// every frame until the first chunk is released, so an attempt that produced
// nothing can be discarded and re-run without the client noticing.
//
// Reasoning is released as it arrives rather than withheld until an answer
// appears (2026-10-02). Withholding it starved the client completely — no bytes
// at all while a thinking model reasoned — and the chat app's 120s TTFT trip
// retried the whole request, so a long-thinking turn cost minutes of dead air
// and duplicate upstream spend.
class MockResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.body = '';
        this.writableEnded = false;
        this.statusCode = 200;
        this.payload = null;
    }
    setHeader(key, value) { this.headers[key] = value; }
    flushHeaders() { }
    write(chunk) { this.body += chunk; return true; }
    status(code) { this.statusCode = code; return this; }
    json(payload) { this.payload = payload; this.writableEnded = true; this.emit('finish'); return this; }
    end() { this.writableEnded = true; this.emit('finish'); this.emit('close'); }
}

const ERROR_FRAME = {
    choices: [],
    error: { code: 502, message: 'Provider returned an empty response', metadata: { error_type: 'provider_unavailable' } }
};
const REASONING = { choices: [{ index: 0, delta: { content: '', reasoning: 'thinking...' }, finish_reason: null }] };
const REASONING_ONLY = { choices: [{ index: 0, delta: { content: '', reasoning: 'thinking...' }, finish_reason: 'stop' }] };
const NOTHING = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
const ANSWER = { choices: [{ index: 0, delta: { content: 'Hello!' }, finish_reason: null }] };
const THROW = err => ({ __throw: err });

// Each entry in `scripts` is the chunk list for one attempt.
function makeRouter(scripts) {
    let calls = 0;
    return {
        get calls() { return calls; },
        async routeChatCompletion() {
            const script = scripts[Math.min(calls, scripts.length - 1)];
            calls++;
            return {
                stream: true,
                context: { window_size: 1000, used_tokens: 10, available_tokens: 990 },
                meta: { model: 'test-model', adapter: 'openai' },
                generator: (async function* () {
                    for (const item of script) {
                        if (item && item.__throw) throw item.__throw;
                        yield item;
                    }
                })()
            };
        }
    };
}

async function run(scripts) {
    const router = makeRouter(scripts);
    const res = new MockResponse();
    const req = { body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }, headers: {}, once() { }, off() { } };
    await createChatHandler(router, null)(req, res, () => { });
    return { router, res };
}

describe('chat route — upstream retry', () => {
    it('retries an in-stream error frame and delivers the good attempt', async () => {
        const { router, res } = await run([[ERROR_FRAME], [ANSWER]]);
        expect(router.calls).to.equal(2);
        expect(res.body).to.include('"content":"Hello!"');
        expect(res.body).to.not.include('provider_unavailable');
        expect(res.statusCode).to.equal(200);
    });

    it('releases reasoning as it arrives and keeps the attempt that answered', async () => {
        const { router, res } = await run([[REASONING, ANSWER]]);
        expect(router.calls).to.equal(1);
        expect(res.body).to.include('"reasoning_content":"thinking..."');
        expect(res.body).to.include('"content":"Hello!"');
        // Reasoning first: that is what keeps a long-thinking turn from looking
        // dead to the client between the request and the answer.
        expect(res.body.indexOf('thinking...')).to.be.lessThan(res.body.indexOf('Hello!'));
    });

    it('reports an answer-less reasoning stream in-band instead of retrying it', async () => {
        const { router, res } = await run([[REASONING_ONLY], [ANSWER]]);
        // Reasoning already reached the client — a retry has nothing to hide and
        // would only spend the upstream's tokens twice.
        expect(router.calls).to.equal(1);
        expect(res.body).to.include('"reasoning_content":"thinking..."');
        expect(res.body).to.not.include('"content":"Hello!"');
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.include('"code":"ZERO_CONTENT"');
        expect(res.body).to.include('streamed reasoning but never produced an answer');
    });

    it('retries an attempt that emitted nothing at all', async () => {
        const { router, res } = await run([[NOTHING], [ANSWER]]);
        expect(router.calls).to.equal(2);
        expect(res.body).to.include('"content":"Hello!"');
    });

    it('surfaces a real HTTP error when every attempt fails', async () => {
        const { router, res } = await run([[ERROR_FRAME], [ERROR_FRAME], [ERROR_FRAME]]);
        expect(router.calls).to.equal(3);
        expect(res.statusCode).to.equal(502);
        expect(res.payload.error.code).to.equal('ZERO_CONTENT');
    });

    it('does not retry a 4xx', async () => {
        const { router, res } = await run([[THROW(Object.assign(new Error('bad request'), { status: 400 }))]]);
        expect(router.calls).to.equal(1);
        expect(res.statusCode).to.equal(400);
    });

    it('does not retry a healthy first attempt', async () => {
        const { router, res } = await run([[ANSWER]]);
        expect(router.calls).to.equal(1);
        expect(res.body).to.include('"content":"Hello!"');
    });

    it('does not retry a failure after content has been committed', async () => {
        const { router, res } = await run([[ANSWER, THROW(Object.assign(new Error('upstream died'), { status: 502 }))]]);
        expect(router.calls).to.equal(1);
        expect(res.body).to.include('"content":"Hello!"');
    });
});
