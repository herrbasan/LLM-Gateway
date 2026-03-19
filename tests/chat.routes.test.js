import { expect } from 'chai';
import EventEmitter from 'node:events';
import { createChatHandler } from '../src/routes/chat.js';

class MockResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.body = '';
        this.writableEnded = false;
        this.statusCode = 200;
    }

    setHeader(key, value) {
        this.headers[key] = value;
    }

    flushHeaders() {}

    write(chunk) {
        this.body += chunk;
        return true;
    }

    status(code) {
        this.statusCode = code;
        return this;
    }

    json(payload) {
        this.payload = payload;
        this.writableEnded = true;
        this.emit('finish');
        return this;
    }

    end() {
        this.writableEnded = true;
        this.emit('finish');
        this.emit('close');
    }
}

describe('Chat Route Cancellation', () => {
    it('aborts streaming upstream work when the HTTP client disconnects', async () => {
        let observedSignal;
        const router = {
            registry: {
                getThinkingConfig: () => ({ enabled: false })
            },
            routeChatCompletion: async (request) => {
                observedSignal = request.signal;
                return {
                    stream: true,
                    generator: (async function* () {
                        yield { choices: [{ delta: { content: 'hello' } }] };
                        await new Promise((resolve) => {
                            request.signal.addEventListener('abort', resolve, { once: true });
                        });
                    })(),
                    context: null
                };
            }
        };

        const handler = createChatHandler(router, null);
        const req = new EventEmitter();
        req.headers = {};
        req.body = {
            stream: true,
            model: 'gemini-flash',
            messages: [{ role: 'user', content: 'hello' }]
        };
        const res = new MockResponse();

        const nextCalls = [];
        const handlerPromise = handler(req, res, (err) => nextCalls.push(err));

        await new Promise(resolve => setTimeout(resolve, 10));
        res.emit('close');
        await handlerPromise;

        expect(observedSignal).to.exist;
        expect(observedSignal.aborted).to.equal(true);
        expect(nextCalls).to.have.length(0);
    });

    it('aborts non-streaming upstream work when the HTTP client disconnects', async () => {
        let observedSignal;
        const router = {
            routeChatCompletion: async (request) => {
                observedSignal = request.signal;
                await new Promise((resolve, reject) => {
                    request.signal.addEventListener('abort', () => {
                        const error = new Error('Request aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
            }
        };

        const handler = createChatHandler(router, null);
        const req = new EventEmitter();
        req.headers = {};
        req.body = {
            model: 'gemini-flash',
            messages: [{ role: 'user', content: 'hello' }]
        };
        const res = new MockResponse();

        const nextCalls = [];
        const handlerPromise = handler(req, res, (err) => nextCalls.push(err));

        await new Promise(resolve => setTimeout(resolve, 10));
        res.emit('close');
        await handlerPromise;

        expect(observedSignal).to.exist;
        expect(observedSignal.aborted).to.equal(true);
        expect(nextCalls).to.have.length(0);
    });
});