/**
 * Integration Tests — Real-World E2E
 * 
 * These tests hit the LIVE running LLM Gateway server.
 * 
 * Prerequisites:
 *   1. Start the gateway:  npm start
 *   2. Have at least one LLM provider running (e.g. lmstudio, ollama)
 *   3. Run:  npm run test:integration
 * 
 * The BASE_URL defaults to http://localhost:3400 (override with LLM_GW_URL env var).
 * 
 * Tests are divided into two groups:
 *   - Gateway-only tests (health, sessions, error handling, CORS) — always run
 *   - LLM-dependent tests (chat, streaming, embeddings) — auto-skipped when
 *     no provider is reachable
 */

import { expect } from 'chai';

const BASE_URL = process.env.LLM_GW_URL || 'http://localhost:3400';

// ---------------------------------------------------------------------------
// Helper: thin fetch wrapper
// ---------------------------------------------------------------------------
async function gw(method, path, body, headers = {}) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const contentType = res.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
        data = await res.json();
    } else {
        data = await res.text();
    }
    return { status: res.status, headers: res.headers, data };
}

// ---------------------------------------------------------------------------
// SSE helper — collects all "data:" lines from a streaming response
// ---------------------------------------------------------------------------
async function collectSSE(path, body, headers = {}, timeoutMs = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
    });

    if (res.status !== 200) {
        clearTimeout(timer);
        return { status: res.status, events: [], fullText: '' };
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
                if (line.startsWith('data: ')) {
                    const payload = line.slice(6).trim();
                    if (payload === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(payload);
                        events.push(parsed);
                        if (parsed.choices?.[0]?.delta?.content) {
                            fullText += parsed.choices[0].delta.content;
                        }
                    } catch {
                        // non-JSON data lines (heartbeats, etc.)
                    }
                }
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
// Provider availability detection
// ---------------------------------------------------------------------------
let availableProviders = [];
let hasLLM = false;
let hasEmbeddings = false;
let defaultProviderWorks = false;

async function probeProviders() {
    const { data } = await gw('GET', '/health');

    // Try a quick chat completion with default provider
    try {
        const probe = await gw('POST', '/v1/chat/completions', {
            model: 'auto',
            messages: [{ role: 'user', content: 'Say OK' }],
            stream: false,
        });
        if (probe.status === 200 && probe.data?.choices?.length > 0) {
            defaultProviderWorks = true;
            hasLLM = true;
        }
    } catch { /* provider down */ }

    // If default didn't work, try each provider individually
    if (!defaultProviderWorks && data?.providers) {
        for (const name of Object.keys(data.providers)) {
            try {
                const probe = await gw('POST', '/v1/chat/completions', {
                    model: 'auto',
                    messages: [{ role: 'user', content: 'Say OK' }],
                    stream: false,
                }, { 'X-Provider': name });
                if (probe.status === 200 && probe.data?.choices?.length > 0) {
                    availableProviders.push(name);
                    hasLLM = true;
                    break; // one is enough
                }
            } catch { /* provider down */ }
        }
    } else if (defaultProviderWorks) {
        availableProviders.push('default');
    }

    // Probe embeddings
    try {
        const emb = await gw('POST', '/v1/embeddings', {
            model: 'auto',
            input: 'test',
        });
        if (emb.status === 200) hasEmbeddings = true;
    } catch { /* */ }
}

/** Skip helper — call at start of `it()` to skip when no LLM is up. */
function requireLLM(ctx) {
    if (!hasLLM) ctx.skip();
}

function requireEmbeddings(ctx) {
    if (!hasEmbeddings) ctx.skip();
}

/** Returns headers that route to an available provider. */
function providerHeader() {
    if (defaultProviderWorks) return {};
    if (availableProviders.length) return { 'X-Provider': availableProviders[0] };
    return {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Integration Tests (live gateway)', function () {
    this.timeout(120_000);

    // ------------------------------------------------------------------
    // Pre-flight
    // ------------------------------------------------------------------
    before(async function () {
        try {
            const { status } = await gw('GET', '/health');
            if (status !== 200) throw new Error(`Health check returned ${status}`);
        } catch (err) {
            console.error(`\n  ✖ Cannot reach ${BASE_URL} — is the gateway running?\n`);
            this.skip();
        }

        console.log(`\n  Probing LLM providers at ${BASE_URL} …`);
        await probeProviders();

        if (hasLLM) {
            console.log(`  ✔ LLM available (providers: ${availableProviders.join(', ') || 'default'})`);
        } else {
            console.log('  ⚠ No LLM provider reachable — LLM-dependent tests will be skipped');
        }
        if (hasEmbeddings) {
            console.log('  ✔ Embeddings available');
        } else {
            console.log('  ⚠ Embeddings not available — embedding tests will be skipped');
        }
        console.log('');
    });

    // ==================================================================
    //  1. HEALTH
    // ==================================================================
    describe('GET /health', () => {
        it('should return status ok and provider list', async () => {
            const { status, data } = await gw('GET', '/health');
            expect(status).to.equal(200);
            expect(data).to.have.property('status', 'ok');
            expect(data).to.have.property('providers');
            expect(Object.keys(data.providers).length).to.be.greaterThan(0);
        });

        it('should report circuit-breaker state for each provider', async () => {
            const { data } = await gw('GET', '/health');
            for (const [, stats] of Object.entries(data.providers)) {
                expect(stats).to.have.property('state');
            }
        });
    });

    // ==================================================================
    //  2. MODELS
    // ==================================================================
    describe('GET /v1/models', () => {
        it('should return an OpenAI-compatible model list', async function () {
            requireLLM(this);
            const { status, data } = await gw('GET', '/v1/models', null, providerHeader());
            expect(status).to.equal(200);
            expect(data).to.have.property('object', 'list');
            expect(data.data).to.be.an('array').that.is.not.empty;
            for (const m of data.data) {
                expect(m).to.have.property('id');
                expect(m).to.have.property('object', 'model');
            }
        });

        it('should accept X-Provider header for model filtering', async function () {
            requireLLM(this);
            const { status, data } = await gw('GET', '/v1/models', null, providerHeader());
            expect(status).to.equal(200);
            expect(data.data).to.be.an('array');
        });
    });

    // ==================================================================
    //  3. CHAT COMPLETIONS (non-streaming)
    // ==================================================================
    describe('POST /v1/chat/completions (non-streaming)', () => {
        it('should return a valid completion for a simple prompt', async function () {
            requireLLM(this);
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
                stream: false,
            }, providerHeader());
            expect(status).to.equal(200);
            expect(data).to.have.property('choices');
            expect(data.choices).to.be.an('array').with.length.greaterThan(0);
            expect(data.choices[0]).to.have.property('message');
            expect(data.choices[0].message).to.have.property('content');
            expect(data.choices[0].message.content.length).to.be.greaterThan(0);
        });

        it('should include usage stats when available', async function () {
            requireLLM(this);
            const { data } = await gw('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [{ role: 'user', content: 'Say hello' }],
                stream: false,
            }, providerHeader());
            if (data.usage) {
                expect(data.usage).to.have.property('prompt_tokens');
                expect(data.usage).to.have.property('completion_tokens');
            }
        });

        it('should honour the system prompt', async function () {
            requireLLM(this);
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [
                    { role: 'system', content: 'You are a pirate. Always reply with "Arrr!".' },
                    { role: 'user', content: 'Hello' },
                ],
                stream: false,
            }, providerHeader());
            expect(status).to.equal(200);
            expect(data.choices[0].message.content.toLowerCase()).to.include('arrr');
        });

        it('should route via X-Provider header', async function () {
            requireLLM(this);
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [{ role: 'user', content: 'Hi' }],
                stream: false,
            }, providerHeader());
            expect(status).to.equal(200);
            expect(data.choices[0].message.content.length).to.be.greaterThan(0);
        });

        it('should return 404 for an unknown provider', async () => {
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'totally_fake_provider:model',
                messages: [{ role: 'user', content: 'Hi' }],
                stream: false,
            });
            expect(status).to.equal(404);
            expect(data).to.have.property('error');
        });
    });

    // ==================================================================
    //  4. STREAMING
    // ==================================================================
    describe('POST /v1/chat/completions (streaming)', () => {
        it('should stream SSE chunks and assemble a coherent response', async function () {
            requireLLM(this);
            const { status, events, fullText } = await collectSSE(
                '/v1/chat/completions',
                {
                    model: 'auto',
                    messages: [{ role: 'user', content: 'Count from 1 to 5 separated by commas.' }],
                    stream: true,
                },
                providerHeader(),
            );
            expect(status).to.equal(200);
            expect(events.length).to.be.greaterThan(0);
            expect(fullText.length).to.be.greaterThan(0);
            expect(fullText).to.match(/[1-5]/);
        });

        it('should include finish_reason in the final chunk', async function () {
            requireLLM(this);
            const { events } = await collectSSE(
                '/v1/chat/completions',
                {
                    model: 'auto',
                    messages: [{ role: 'user', content: 'Say ok' }],
                    stream: true,
                },
                providerHeader(),
            );
            expect(events.length).to.be.greaterThan(0);
            const last = events[events.length - 1];
            if (last?.choices?.[0]) {
                expect(last.choices[0]).to.have.property('finish_reason');
            }
        });
    });

    // ==================================================================
    //  5. SESSIONS — full lifecycle
    // ==================================================================
    describe('Sessions lifecycle', () => {
        let sessionId;

        it('should create a session', async () => {
            const { status, data } = await gw('POST', '/v1/sessions', { strategy: 'truncate' });
            expect(status).to.equal(201);
            expect(data.session).to.have.property('id');
            sessionId = data.session.id;
        });

        it('should retrieve the session', async () => {
            const { status, data } = await gw('GET', `/v1/sessions/${sessionId}`);
            expect(status).to.equal(200);
            expect(data.session.id).to.equal(sessionId);
            expect(data.session.message_count).to.equal(0);
        });

        it('should send a message through the session and accumulate history', async function () {
            requireLLM(this);
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [{ role: 'user', content: 'My favourite colour is blue. Remember that.' }],
                stream: false,
            }, { ...providerHeader(), 'X-Session-Id': sessionId });

            expect(status).to.equal(200);
            expect(data.choices[0].message.content.length).to.be.greaterThan(0);

            const sess = await gw('GET', `/v1/sessions/${sessionId}`);
            expect(sess.data.session.message_count).to.be.greaterThan(0);
        });

        it('should recall session context in a follow-up message', async function () {
            requireLLM(this);
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [{ role: 'user', content: 'What is my favourite colour?' }],
                stream: false,
            }, { ...providerHeader(), 'X-Session-Id': sessionId });

            expect(status).to.equal(200);
            expect(data.choices[0].message.content.toLowerCase()).to.include('blue');
        });

        it('should patch session settings', async () => {
            const { status, data } = await gw('PATCH', `/v1/sessions/${sessionId}`, {
                strategy: 'compress',
            });
            expect(status).to.equal(200);
            expect(data.session.context.strategy).to.equal('compress');
        });

        it('should delete the session', async () => {
            const { status } = await gw('DELETE', `/v1/sessions/${sessionId}`);
            expect(status).to.equal(204);

            const { status: getStatus } = await gw('GET', `/v1/sessions/${sessionId}`);
            expect(getStatus).to.equal(404);
        });
    });

    // ==================================================================
    //  6. EMBEDDINGS
    // ==================================================================
    describe('POST /v1/embeddings', () => {
        it('should return embedding vectors for a single input', async function () {
            requireEmbeddings(this);
            const { status, data } = await gw('POST', '/v1/embeddings', {
                model: 'auto',
                input: 'The quick brown fox jumps over the lazy dog',
            }, providerHeader());
            expect(status).to.equal(200);
            expect(data).to.have.property('data');
            expect(data.data).to.be.an('array').with.length.greaterThan(0);
            expect(data.data[0]).to.have.property('embedding');
            expect(data.data[0].embedding).to.be.an('array').with.length.greaterThan(0);
        });

        it('should return embeddings for an array of inputs', async function () {
            requireEmbeddings(this);
            const { status, data } = await gw('POST', '/v1/embeddings', {
                model: 'auto',
                input: ['Hello world', 'Goodbye world'],
            }, providerHeader());
            expect(status).to.equal(200);
            expect(data.data).to.have.length(2);
        });
    });

    // ==================================================================
    //  7. STRUCTURED OUTPUT (JSON mode)
    // ==================================================================
    describe('Structured output / JSON mode', () => {
        it('should return valid JSON when response_format is json_object', async function () {
            requireLLM(this);
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [
                    { role: 'system', content: 'Respond in JSON only.' },
                    { role: 'user', content: 'Give me a JSON object with keys "name" and "age" for a fictional character.' },
                ],
                response_format: { type: 'json_object' },
                stream: false,
            }, providerHeader());
            if (status === 400) {
                console.log('      (structured output not supported by this provider — skipped)');
                return;
            }
            expect(status).to.equal(200);
            const content = data.choices[0].message.content;
            const parsed = JSON.parse(content);
            expect(parsed).to.be.an('object');
        });
    });

    // ==================================================================
    //  8. MULTI-TURN CONVERSATION (stateless)
    // ==================================================================
    describe('Multi-turn stateless conversation', () => {
        it('should handle multiple messages in a single request', async function () {
            requireLLM(this);
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [
                    { role: 'system', content: 'You are a helpful assistant.' },
                    { role: 'user', content: 'What is 2+2?' },
                    { role: 'assistant', content: '4' },
                    { role: 'user', content: 'And what is that times 3?' },
                ],
                stream: false,
            }, providerHeader());
            expect(status).to.equal(200);
            expect(data.choices[0].message.content).to.match(/12/);
        });
    });

    // ==================================================================
    //  9. ERROR HANDLING
    // ==================================================================
    describe('Error handling', () => {
        it('should return 404 for non-existent routes', async () => {
            const { status } = await gw('GET', '/v1/nonexistent');
            expect(status).to.equal(404);
        });

        it('should return 404 for non-existent session', async () => {
            const { status } = await gw('GET', '/v1/sessions/does-not-exist-123');
            expect(status).to.equal(404);
        });

        it('should return 404 for non-existent task ticket', async () => {
            const { status } = await gw('GET', '/v1/tasks/fake-ticket-000');
            expect(status).to.equal(404);
        });

        it('should handle malformed JSON gracefully', async () => {
            const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{ invalid json }}}',
            });
            expect(res.status).to.be.within(400, 500);
        });

        it('should return an error for unknown provider in model string', async () => {
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'totally_fake_provider:model',
                messages: [{ role: 'user', content: 'Hi' }],
                stream: false,
            });
            expect(status).to.equal(404);
            expect(data.error).to.include('No adapter found');
        });

        it('should return 404 when using a non-existent session ID for chat', async () => {
            const { status, data } = await gw('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [{ role: 'user', content: 'test' }],
                stream: false,
            }, { 'X-Session-Id': 'ghost-session-id' });
            expect(status).to.equal(404);
            expect(data.error).to.include('Session Not Found');
        });
    });

    // ==================================================================
    // 10. CONCURRENT REQUESTS
    // ==================================================================
    describe('Concurrency', () => {
        it('should handle 3 simultaneous requests', async function () {
            requireLLM(this);
            const promises = Array.from({ length: 3 }, (_, i) =>
                gw('POST', '/v1/chat/completions', {
                    model: 'auto',
                    messages: [{ role: 'user', content: `Say the number ${i + 1}` }],
                    stream: false,
                }, providerHeader()),
            );
            const results = await Promise.all(promises);
            for (const r of results) {
                expect(r.status).to.equal(200);
                expect(r.data.choices[0].message.content.length).to.be.greaterThan(0);
            }
        });
    });

    // ==================================================================
    // 11. CORS
    // ==================================================================
    describe('CORS', () => {
        it('should return CORS headers on OPTIONS', async () => {
            const res = await fetch(`${BASE_URL}/v1/chat/completions`, { method: 'OPTIONS' });
            expect(res.headers.get('access-control-allow-origin')).to.equal('*');
            expect(res.headers.get('access-control-allow-methods')).to.include('POST');
        });
    });
});
