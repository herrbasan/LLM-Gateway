import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createKimiAdapter } from '../src/adapters/kimi.js';

describe('Kimi Adapter', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('should send max_completion_tokens for chat completions', async () => {
        const adapter = createKimiAdapter();
        let payload;

        global.fetch = async (_url, options = {}) => {
            payload = JSON.parse(options.body);
            return {
                ok: true,
                json: async () => ({
                    id: 'cmpl-1',
                    object: 'chat.completion',
                    created: 0,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'ok' },
                        finish_reason: 'stop'
                    }]
                })
            };
        };

        await adapter.chatComplete({
            endpoint: 'https://api.kimi.com/coding/v1',
            adapterModel: 'kimi-k2.5',
            apiKey: 'test-key',
            capabilities: {}
        }, {
            messages: [{ role: 'user', content: 'Hello' }],
            maxTokens: 4096
        });

        expect(payload.max_completion_tokens).to.equal(4096);
        expect(payload.max_tokens).to.equal(4096);
    });

    it('should skip native counting without an explicit tokenizer endpoint', async () => {
        const adapter = createKimiAdapter();
        let called = false;

        global.fetch = async () => {
            called = true;
            throw new Error('fetch should not be called');
        };

        const count = await adapter.countMessageTokens([
            { role: 'user', content: 'Hello' }
        ], {
            endpoint: 'https://api.kimi.com/coding/v1',
            adapterModel: 'kimi-k2.5',
            apiKey: 'test-key'
        });

        expect(called).to.equal(false);
        expect(count).to.equal(null);
    });

    it('should honor explicit tokenizer endpoint overrides', async () => {
        const adapter = createKimiAdapter();
        let url;

        global.fetch = async (requestUrl) => {
            url = requestUrl;
            return {
                ok: true,
                json: async () => ({
                    data: { total_tokens: 1234 }
                })
            };
        };

        const count = await adapter.countMessageTokens([
            { role: 'user', content: 'Hello' }
        ], {
            endpoint: 'https://api.kimi.com/coding/v1',
            tokenizerEndpoint: 'https://custom-tokenizer.example/v1/',
            adapterModel: 'kimi-k2.5',
            apiKey: 'test-key'
        });

        expect(url).to.equal('https://custom-tokenizer.example/v1/tokenizers/estimate-token-count');
        expect(count).to.equal(1234);
    });
});