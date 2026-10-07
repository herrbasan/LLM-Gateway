/**
 * Gemini — excludeParams is honoured on this adapter.
 *
 * The capability existed and worked on the anthropic adapter, so a config that
 * declared it read as a guard. The gemini adapter never read it, which meant the
 * declaration protected nothing there — worse than not offering it, because the
 * config looked correct.
 *
 * The deprecation makes that concrete: Google is turning temperature, top_p and
 * top_k into hard 400s on upcoming models. Gemini 3.6+ already ignores custom
 * values, so stripping them now costs no behaviour and prevents an outage.
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

const BASE = {
    type: 'chat',
    adapter: 'gemini',
    adapterModel: 'gemini-3.8-flash',
    endpoint: 'https://upstream.invalid/v1beta',
    apiKey: 'test-key',
    capabilities: { contextWindow: 1048576, maxOutputTokens: 65536 }
};

const EXCLUDING = {
    ...BASE,
    capabilities: { ...BASE.capabilities, excludeParams: ['temperature', 'top_p', 'top_k'] }
};

const SAMPLING = { temperature: 0.7, top_p: 0.9, top_k: 40 };

async function dispatch(model, request) {
    const sent = captureUpstream();
    let error = null;
    try {
        await adapters.get('gemini').chatComplete(model, {
            messages: [{ role: 'user', content: 'hi' }],
            ...request
        });
    } catch (err) {
        error = err;
    }
    expect(sent, `upstream call failed before sending: ${error?.message}`).to.have.length(1);
    return sent[0];
}

describe('Gemini adapter — excludeParams', () => {
    it('strips declared sampling params before dispatch', async () => {
            // maxTokens keeps generation_config present, so this proves the strip
            // rather than the emptying that the last test covers.
            const body = await dispatch(EXCLUDING, { ...SAMPLING, maxTokens: 4096 });
            expect(body.generation_config).to.be.an('object');
            expect(body.generation_config).to.not.have.property('temperature');
            expect(body.generation_config).to.not.have.property('top_p');
            expect(body.generation_config).to.not.have.property('top_k');
            expect(body.generation_config.max_output_tokens).to.equal(4096);
        });

    it('leaves sampling params alone when the model does not exclude them', async () => {
        const body = await dispatch(BASE, SAMPLING);
        expect(body.generation_config.temperature).to.equal(0.7);
        expect(body.generation_config.top_p).to.equal(0.9);
        expect(body.generation_config.top_k).to.equal(40);
    });

    it('never strips thinking_level — the supported control, not a sampling override', async () => {
        const body = await dispatch(EXCLUDING, { reasoning_effort: 'medium' });
        expect(body.generation_config.thinking_level).to.equal('medium');
    });

    it('keeps non-sampling generation config intact', async () => {
        const body = await dispatch(EXCLUDING, { maxTokens: 4096, seed: 7, stop: ['END'] });
        expect(body.generation_config.max_output_tokens).to.equal(4096);
        expect(body.generation_config.seed).to.equal(7);
        expect(body.generation_config.stop_sequences).to.deep.equal(['END']);
    });

    it('omits generation_config entirely when exclusion empties it', async () => {
        const body = await dispatch(EXCLUDING, SAMPLING);
        expect(body).to.not.have.property('generation_config');
    });
});