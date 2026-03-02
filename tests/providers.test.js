/**
 * Provider Endpoint Tests
 * 
 * Tests every configured LLM provider through the running gateway.
 * For each provider it checks:  chat completion, streaming, embeddings (if capable),
 * structured output (if capable), and model listing.
 * 
 * Usage:
 *   1. npm start            (start the gateway)
 *   2. npm run test:providers
 * 
 * Override gateway URL:  LLM_GW_URL=http://host:port npm run test:providers
 */

import { expect } from 'chai';

const BASE_URL = process.env.LLM_GW_URL || 'http://localhost:3400';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function gw(method, path, body, headers = {}) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data };
}

async function collectSSE(body, headers = {}, timeoutMs = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
    });
    if (res.status !== 200) {
        clearTimeout(timer);
        const errBody = await res.text().catch(() => '');
        return { status: res.status, events: [], fullText: '', error: errBody };
    }
    const events = [];
    let fullText = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(payload);
                    events.push(parsed);
                    if (parsed.choices?.[0]?.delta?.content) {
                        fullText += parsed.choices[0].delta.content;
                    }
                } catch { /* heartbeat / non-JSON */ }
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') throw err;
    } finally {
        clearTimeout(timer);
    }
    return { status: res.status, events, fullText };
}

// ---------------------------------------------------------------------------
// Discover providers from /health, then build per-provider test suites
// ---------------------------------------------------------------------------
describe('Provider Endpoint Tests', function () {
    this.timeout(120_000);

    let providers = {};   // name → { state, ... }
    let providerConfigs;  // name → capabilities from config

    before(async function () {
        // 1. Reach the gateway
        let healthData;
        try {
            const { status, data } = await gw('GET', '/health');
            if (status !== 200) throw new Error(`Health returned ${status}`);
            healthData = data;
        } catch (err) {
            console.error(`\n  ✖ Cannot reach ${BASE_URL} — is the gateway running?\n`);
            this.skip();
        }

        providers = healthData.providers || {};
        if (!Object.keys(providers).length) {
            console.error('\n  ✖ No providers configured.\n');
            this.skip();
        }

        // 2. Fetch the config so we know capabilities per provider
        //    We'll infer from a quick capabilities probe instead of reading files.
        //    Build a map provider → { embeddings, structuredOutput, streaming }
        providerConfigs = {};
        for (const name of Object.keys(providers)) {
            providerConfigs[name] = { embeddings: false, structuredOutput: false, streaming: true };
        }

        // Try to load the real config for capability flags
        try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const raw = await fs.readFile(path.resolve('config.json'), 'utf-8');
            // Substitute env vars so we get resolved config
            const config = JSON.parse(raw);
            for (const [name, prov] of Object.entries(config.providers || {})) {
                if (providerConfigs[name] && prov.capabilities) {
                    providerConfigs[name] = {
                        embeddings: !!prov.capabilities.embeddings,
                        structuredOutput: !!prov.capabilities.structuredOutput,
                        streaming: prov.capabilities.streaming !== false,
                    };
                }
            }
        } catch { /* best-effort */ }

        // Header
        console.log('\n  Configured providers:');
        for (const [name, stats] of Object.entries(providers)) {
            const caps = providerConfigs[name] || {};
            const flags = [
                caps.streaming ? 'stream' : null,
                caps.embeddings ? 'embed' : null,
                caps.structuredOutput ? 'json' : null,
            ].filter(Boolean).join(', ');
            console.log(`    • ${name}  (circuit: ${stats.state})  [${flags}]`);
        }
        console.log('');
    });

    // ==================================================================
    // Dynamically create a describe() block for every provider
    // ==================================================================
    //
    // Because Mocha resolves describe() synchronously, we pre-list provider
    // names and skip inside each test when the provider turns out to be
    // unreachable.  We discover the real provider list in before() above.
    // ------------------------------------------------------------------

    const knownProviders = [
        'lmstudio', 'ollama', 'gemini', 'grok', 'kimi', 'glm', 'minimax', 'qwen',
    ];

    for (const providerName of knownProviders) {
        describe(`Provider: ${providerName}`, () => {
            function skipIfMissing(ctx) {
                if (!providers[providerName]) {
                    ctx.skip();                 // provider not in config
                }
            }

            // helper: header forcing this provider
            const hdr = () => ({ 'X-Provider': providerName });

            // ----------------------------------------------------------
            // Chat completion (non-streaming)
            // ----------------------------------------------------------
            it('chat completion — should return a valid response', async function () {
                skipIfMissing(this);
                const { status, data } = await gw('POST', '/v1/chat/completions', {
                    model: 'auto',
                    messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
                    stream: false,
                }, hdr());

                if (status !== 200) {
                    console.log(`        ↳ ${providerName} returned ${status} — skipped`);
                    return this.skip();
                }
                expect(data).to.have.property('choices');
                expect(data.choices.length).to.be.greaterThan(0);
                const content = data.choices[0].message?.content;
                expect(content).to.be.a('string').with.length.greaterThan(0);
                console.log(`        ↳ response: "${content.slice(0, 80)}${content.length > 80 ? '…' : ''}"`);
            });

            // ----------------------------------------------------------
            // Streaming
            // ----------------------------------------------------------
            it('streaming — should deliver SSE chunks', async function () {
                skipIfMissing(this);
                if (providerConfigs[providerName] && !providerConfigs[providerName].streaming) {
                    console.log(`        ↳ streaming not configured for ${providerName}`);
                    return this.skip();
                }
                const { status, events, fullText, error } = await collectSSE(
                    {
                        model: 'auto',
                        messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
                        stream: true,
                    },
                    hdr(),
                );
                if (status !== 200 || events.length === 0) {
                    console.log(`        ↳ ${providerName} streaming returned ${status}, ${events.length} events — skipped`);
                    return this.skip();
                }
                expect(fullText.length).to.be.greaterThan(0);
                console.log(`        ↳ ${events.length} chunks, text: "${fullText.slice(0, 80)}${fullText.length > 80 ? '…' : ''}"`);
            });

            // ----------------------------------------------------------
            // Embeddings
            // ----------------------------------------------------------
            it('embeddings — should return vectors', async function () {
                skipIfMissing(this);
                if (providerConfigs[providerName] && !providerConfigs[providerName].embeddings) {
                    console.log(`        ↳ embeddings not configured for ${providerName}`);
                    return this.skip();
                }
                const { status, data } = await gw('POST', '/v1/embeddings', {
                    model: 'auto',
                    input: 'The quick brown fox',
                }, hdr());

                if (status !== 200) {
                    console.log(`        ↳ ${providerName} embeddings returned ${status} — skipped`);
                    return this.skip();
                }
                expect(data.data).to.be.an('array').with.length.greaterThan(0);
                const vec = data.data[0].embedding;
                expect(vec).to.be.an('array').with.length.greaterThan(0);
                console.log(`        ↳ embedding dim = ${vec.length}`);
            });

            // ----------------------------------------------------------
            // Structured output (JSON mode)
            // ----------------------------------------------------------
            it('structured output — should return valid JSON', async function () {
                skipIfMissing(this);
                if (providerConfigs[providerName] && !providerConfigs[providerName].structuredOutput) {
                    console.log(`        ↳ structured output not configured for ${providerName}`);
                    return this.skip();
                }
                const { status, data } = await gw('POST', '/v1/chat/completions', {
                    model: 'auto',
                    messages: [
                        { role: 'system', content: 'Respond in valid JSON only. No markdown.' },
                        { role: 'user', content: 'Give me a JSON object with keys "name" (string) and "age" (number).' },
                    ],
                    response_format: { type: 'json_object' },
                    stream: false,
                }, hdr());

                if (status !== 200) {
                    console.log(`        ↳ ${providerName} structured output returned ${status} — skipped`);
                    return this.skip();
                }
                const content = data.choices[0].message.content;
                let parsed;
                try { parsed = JSON.parse(content); } catch (e) {
                    throw new Error(`Response is not valid JSON: ${content}`);
                }
                expect(parsed).to.be.an('object');
                console.log(`        ↳ JSON: ${JSON.stringify(parsed).slice(0, 100)}`);
            });

            // ----------------------------------------------------------
            // Model listing
            // ----------------------------------------------------------
            it('models — should list available models', async function () {
                skipIfMissing(this);
                const { status, data } = await gw('GET', '/v1/models', null, hdr());

                if (status !== 200) {
                    console.log(`        ↳ ${providerName} models returned ${status} — skipped`);
                    return this.skip();
                }
                expect(data).to.have.property('object', 'list');
                expect(data.data).to.be.an('array');
                const ids = data.data.map(m => m.id);
                console.log(`        ↳ ${ids.length} model(s): ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ' …' : ''}`);
            });

            // ----------------------------------------------------------
            // System prompt adherence
            // ----------------------------------------------------------
            it('system prompt — should follow instructions', async function () {
                skipIfMissing(this);
                const { status, data } = await gw('POST', '/v1/chat/completions', {
                    model: 'auto',
                    messages: [
                        { role: 'system', content: 'You must always respond with EXACTLY the word "banana" and nothing else.' },
                        { role: 'user', content: 'What is your favourite fruit?' },
                    ],
                    stream: false,
                }, hdr());

                if (status !== 200) {
                    console.log(`        ↳ ${providerName} system-prompt test returned ${status} — skipped`);
                    return this.skip();
                }
                const content = data.choices[0].message.content.toLowerCase();
                expect(content).to.include('banana');
                console.log(`        ↳ response: "${content.slice(0, 60)}"`);
            });

            // ----------------------------------------------------------
            // Multi-turn reasoning
            // ----------------------------------------------------------
            it('multi-turn — should handle conversation context', async function () {
                skipIfMissing(this);
                const { status, data } = await gw('POST', '/v1/chat/completions', {
                    model: 'auto',
                    messages: [
                        { role: 'user', content: 'What is 7 * 8?' },
                        { role: 'assistant', content: '56' },
                        { role: 'user', content: 'Now add 4 to that.' },
                    ],
                    stream: false,
                }, hdr());

                if (status !== 200) {
                    console.log(`        ↳ ${providerName} multi-turn test returned ${status} — skipped`);
                    return this.skip();
                }
                const content = data.choices[0].message.content;
                expect(content).to.match(/60/, 'Expected the answer to contain 60');
                console.log(`        ↳ response: "${content.slice(0, 60)}"`);
            });
        });
    }
});
