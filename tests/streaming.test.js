import { expect } from 'chai';
import { StreamHandler } from '../src/streaming/sse.js';
import EventEmitter from 'node:events';

class MockResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.body = '';
        this.writableEnded = false;
    }
    setHeader(k, v) { this.headers[k] = v; }
    flushHeaders() {}
    write(chunk) {
        this.body += chunk;
        return true;
    }
    end() {
        this.writableEnded = true;
        this.emit('close');
    }
}

describe('Streaming & SSE', () => {
    it('should set appropriate headers, format data, and terminate with [DONE]', async () => {
        const res = new MockResponse();
        const handler = new StreamHandler(res, { heartbeatIntervalMs: 100 });
        
        async function* mockGenerator() {
            yield { choices: [{ delta: { content: 'chunk1' } }] };
            yield { choices: [{ delta: { content: 'chunk2' } }] };
        }

        await handler.process(mockGenerator());

        expect(res.headers['Content-Type']).to.equal('text/event-stream');
        expect(res.headers['Cache-Control']).to.equal('no-cache');
        expect(res.headers['Connection']).to.equal('keep-alive');

        expect(res.body).to.include('"content":"chunk1"');
        expect(res.body).to.include('"content":"chunk2"');
        expect(res.body).to.include('data: [DONE]');
    });

    it('should inject heartbeat comments', async () => {
        const res = new MockResponse();
        const handler = new StreamHandler(res, { heartbeatIntervalMs: 10 });
        handler.start();
        
        await new Promise(r => setTimeout(r, 25)); // longer than 10ms
        
        handler.cleanup();
        expect(res.body).to.include(': heartbeat\n\n');
    });

    it('should re-throw (not flush SSE headers) when the generator errors before any content', async () => {
        const res = new MockResponse();
        const handler = new StreamHandler(res);

        async function* failingGenerator() {
            throw new Error('Upstream fetch failed');
        }

        let caught;
        try {
            await handler.process(failingGenerator());
        } catch (err) {
            caught = err;
        }

        // The error must propagate so the caller can send a proper HTTP error.
        expect(caught).to.exist;
        expect(caught.message).to.equal('Upstream fetch failed');
        // SSE headers must NOT have been flushed — response is still mutable.
        expect(res.headers['Content-Type']).to.be.undefined;
        expect(res.body).to.equal('');
        expect(res.writableEnded).to.be.false;
    });

    it('should re-throw ZERO_CONTENT when the generator yields nothing sendable', async () => {
        const res = new MockResponse();
        const handler = new StreamHandler(res);

        async function* emptyGenerator() {
            // yields only metadata-only chunks that get skipped
            yield { choices: [] };
        }

        let caught;
        try {
            await handler.process(emptyGenerator());
        } catch (err) {
            caught = err;
        }

        expect(caught).to.exist;
        expect(caught.code).to.equal('ZERO_CONTENT');
        expect(res.headers['Content-Type']).to.be.undefined;
        expect(res.body).to.equal('');
    });

    it('should flush headers only on first content chunk, not upfront', async () => {
        const res = new MockResponse();
        const handler = new StreamHandler(res);

        async function* slowGenerator() {
            yield { choices: [{ delta: { content: 'hello' } }] };
            yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        }

        await handler.process(slowGenerator());

        expect(res.headers['Content-Type']).to.equal('text/event-stream');
        expect(res.body).to.include('"content":"hello"');
        expect(res.body).to.include('data: [DONE]');
    });
});
