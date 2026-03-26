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

        expect(res.body).to.include('data: {"choices":[{"delta":{"content":"chunk1"}}]}');
        expect(res.body).to.include('data: {"choices":[{"delta":{"content":"chunk2"}}]}');
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
});
