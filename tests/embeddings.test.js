import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { loadConfig } from '../src/config.js';
import { ModelRegistry } from '../src/core/model-registry.js';
import { createEmbeddingsHandler } from '../src/routes/embeddings.js';
import { createWizkidEmbeddingsHandler } from '../src/routes/embeddings-wizkid.js';

function response(body, status = 200, headers = {}) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers }
    });
}

function stubFetch(result) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return result;
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
}

function makeRes() {
    return {
        statusCode: null,
        headers: {},
        body: null,
        status(code) { this.statusCode = code; return this; },
        setHeader(name, value) { this.headers[name] = value; },
        send(body) { this.body = body; return this; }
    };
}

describe('Generic embeddings route', () => {
    let restoreFetch = null;
    let previousToken;

    beforeEach(() => {
        previousToken = process.env.OVEM_API_TOKEN;
    });

    afterEach(() => {
        if (restoreFetch) restoreFetch();
        restoreFetch = null;
        if (previousToken === undefined) delete process.env.OVEM_API_TOKEN;
        else process.env.OVEM_API_TOKEN = previousToken;
    });

    it('forwards the configured provider token as a bearer header without logging it', async () => {
        const providerToken = 'provider-token-that-must-stay-private';
        process.env.OVEM_API_TOKEN = providerToken;
        const stub = stubFetch(response({ object: 'list', data: [] }));
        restoreFetch = stub.restore;
        const handler = createEmbeddingsHandler();
        const res = makeRes();
        const nextErrors = [];

        await handler({ body: { input: 'hello' } }, res, err => nextErrors.push(err));

        expect(nextErrors).to.be.empty;
        expect(res.statusCode).to.equal(200);
        expect(stub.calls[0].options.headers).to.deep.equal({
            'Content-Type': 'application/json',
            Authorization: `Bearer ${providerToken}`
        });
        expect(JSON.stringify(stub.calls[0].body)).to.not.include(providerToken);
    });
});

describe('Wizkid embeddings route', () => {
    let restoreFetch = null;

    afterEach(() => {
        if (restoreFetch) restoreFetch();
        restoreFetch = null;
    });

    async function invoke(body, upstreamResponse = response({ object: 'list', data: [] })) {
        const stub = stubFetch(upstreamResponse);
        restoreFetch = stub.restore;
        const registry = new ModelRegistry(await loadConfig());
        const handler = createWizkidEmbeddingsHandler({ registry });
        const res = makeRes();
        const nextErrors = [];
        await handler({ body }, res, err => nextErrors.push(err));
        return { stub, res, nextErrors };
    }

    it('uses the fixed Wizkid model and forwards embedding options', async () => {
        const { stub, res, nextErrors } = await invoke({
            input: 'hello',
            dimensions: 2560,
            encoding_format: 'base64'
        });

        expect(nextErrors).to.be.empty;
        expect(res.statusCode).to.equal(200);
        expect(stub.calls[0].url).to.equal('http://192.168.0.140:8765/v1/embeddings');
        expect(stub.calls[0].body).to.deep.equal({
            input: 'hello',
            model: 'qwen3-embedding-4b',
            dimensions: 2560,
            encoding_format: 'base64'
        });
        expect(stub.calls[0].options.headers.Authorization).to.equal('Bearer test-ovem-token');
    });

    it('passes an upstream queue-full response through with Retry-After', async () => {
        const errorBody = JSON.stringify({
            error: { message: 'embedding queue is full', type: 'rate_limit_error', code: 'queue_full' }
        });
        const { res, nextErrors } = await invoke(
            { input: ['hello'] },
            response(errorBody, 429, { 'retry-after': '30' })
        );

        expect(nextErrors).to.be.empty;
        expect(res.statusCode).to.equal(429);
        expect(res.headers['Retry-After']).to.equal('30');
        expect(res.body).to.equal(errorBody);
    });
});
