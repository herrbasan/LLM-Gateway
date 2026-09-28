import { expect } from 'chai';
import { createOpenAIAdapter } from '../src/adapters/openai.js';

// Some OpenAI-compatible routers report a failed generation as an ordinary SSE
// frame — empty choices plus an `error` object. OpenRouter's stealth slot does
// this with `{"choices":[],"error":{"code":502,"message":"JSON error injected
// into SSE stream","metadata":{"error_type":"provider_unavailable"}}}`.
// Yielding that frame looks like a content-free stream, so the caller raises
// its own ZERO_CONTENT and the real cause is lost.
describe('openai adapter — in-stream error frames', () => {
    const CAPTURED = 'data: {"id":"gen-1","object":"chat.completion.chunk","created":1,'
        + '"model":"stealth/space-bunny-alpha","provider":"Stealth","choices":[],'
        + '"error":{"code":502,"message":"JSON error injected into SSE stream",'
        + '"metadata":{"error_type":"provider_unavailable"}}}\n\n';

    const OK_BODY = 'data: {"id":"gen-2","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'
        + 'data: [DONE]\n\n';

    const originalFetch = globalThis.fetch;
    let body = CAPTURED;

    before(() => {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'text/event-stream']]),
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(body));
                    controller.close();
                }
            })
        });
    });

    after(() => { globalThis.fetch = originalFetch; });

    const modelConfig = { endpoint: 'http://stub.local/v1', apiKey: 'test', adapterModel: 'test-model', capabilities: {} };
    const request = { messages: [{ role: 'user', content: 'x' }] };

    it('throws with the upstream status instead of yielding the error frame', async () => {
        body = CAPTURED;
        const adapter = createOpenAIAdapter();
        let caught = null;
        const seen = [];
        try {
            for await (const chunk of adapter.streamComplete(modelConfig, request)) seen.push(chunk);
        } catch (err) {
            caught = err;
        }
        expect(seen, 'should not yield the error frame').to.have.length(0);
        expect(caught).to.be.an('error');
        expect(caught.status).to.equal(502);
        expect(caught.message).to.match(/JSON error injected into SSE stream/);
    });

    it('streams a normal response unchanged', async () => {
        body = OK_BODY;
        const adapter = createOpenAIAdapter();
        const seen = [];
        for await (const chunk of adapter.streamComplete(modelConfig, request)) seen.push(chunk);
        expect(seen[0].choices[0].delta.content).to.equal('hi');
    });
});
