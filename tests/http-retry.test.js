// Unit tests for the 429 rate-limit retry in src/utils/http.js — global fetch
// is mocked; no network, no gateway server. Real-shape bodies: Gemini's 429
// arrives SSE-framed with "Please retry in Ns" in the message; GLM's quota 429
// names a far-future reset with no retry-seconds phrase.
import { expect } from 'chai';
import { request } from '../src/utils/http.js';

describe('HTTP 429 rate-limit retry', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    const gemini429 = (retrySecs) => new Response(
        `event: error\ndata: {"error":{"message":"Rate limit exceeded for model gemini-3.8-flash`
        + ` (limit: 3000000 input tokens per minute on Tier 2). Please retry in ${retrySecs}s`
        + ` or upgrade your tier at https://ai.dev/rate-limit.","code":"rate_limit_exceeded"},`
        + `"event_type":"error"}\n\n`,
        { status: 429, statusText: 'Too Many Requests' }
    );

    const glm429 = () => new Response(
        JSON.stringify({ error: { code: '1308', message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-09-21 03:28:08' } }),
        { status: 429, statusText: 'Too Many Requests' }
    );

    const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

    it('retries once on a 429 that names a retry window, then succeeds', async () => {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return calls === 1 ? gemini429(1) : ok(); };

        const res = await request('http://upstream.test/v1/interactions');
        expect(res.status).to.equal(200);
        expect(calls).to.equal(2);
    }).timeout(8000);

    it('does not retry a 429 with no named window (GLM 5-hour quota)', async () => {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return glm429(); };

        let thrown = null;
        try { await request('http://upstream.test/v1/chat/completions'); } catch (e) { thrown = e; }
        expect(thrown).to.exist;
        expect(thrown.status).to.equal(429);
        expect(thrown.code).to.equal('RATE_LIMIT');
        expect(calls).to.equal(1);
    });

    it('does not retry when the named window exceeds the cap, but reports retryAfter', async () => {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return gemini429(120); };

        let thrown = null;
        try { await request('http://upstream.test/v1/interactions'); } catch (e) { thrown = e; }
        expect(thrown).to.exist;
        expect(thrown.status).to.equal(429);
        expect(thrown.retryAfter).to.be.a('number').greaterThan(Date.now());
        expect(calls).to.equal(1);
    });

    it('stops after rateLimitMaxRetries when the 429 repeats', async () => {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return gemini429(1); };

        let thrown = null;
        try { await request('http://upstream.test/v1/interactions'); } catch (e) { thrown = e; }
        expect(thrown).to.exist;
        expect(thrown.status).to.equal(429);
        expect(calls).to.equal(2); // initial + the single allowed retry
    }).timeout(8000);

    it('honours a Retry-After header when the body names no window', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            return calls === 1
                ? new Response('{}', { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '1' } })
                : ok();
        };

        const res = await request('http://upstream.test/v1/chat/completions');
        expect(res.status).to.equal(200);
        expect(calls).to.equal(2);
    }).timeout(8000);
});
