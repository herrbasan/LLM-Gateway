/**
 * Probe: is the "overseas" Kimi Code endpoint (api.kimi.ai) usable with this
 * subscription key from Europe, and is it faster than the China one
 * (api.kimi.com)?
 *
 * Both endpoints are documented side by side (models.html, 2026-10-23):
 *   China    https://api.kimi.com/coding/
 *   Overseas https://api.kimi.ai/coding/
 * Same path, same protocol — so the only way to choose is to measure: does the
 * key authenticate, does it serve the same model, and what is the latency?
 *
 * Run: node scripts/probe-kimi-region.mjs [modelId] [rounds]
 */
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'kimi-k31-chat';
const rounds = Number(process.argv[3] || 3);
const model = config.models[modelId];

const hosts = [
    { label: 'china    api.kimi.com', base: 'https://api.kimi.com/coding' },
    { label: 'overseas api.kimi.ai ', base: 'https://api.kimi.ai/coding' }
];

const body = JSON.stringify({
    model: model.adapterModel,
    max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }] }]
});

function headers() {
    return {
        'content-type': 'application/json',
        'x-api-key': model.apiKey,
        'anthropic-version': '2023-06-01'
    };
}

async function timedFetch(url, init) {
    const started = process.hrtime.bigint();
    let firstByteMs = null;
    const response = await fetch(url, init);
    const reader = response.body?.getReader();
    let raw = '';
    if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (firstByteMs == null) firstByteMs = Number(process.hrtime.bigint() - started) / 1e6;
            raw += decoder.decode(value, { stream: true });
        }
    } else {
        raw = await response.text();
    }
    return {
        status: response.status,
        totalMs: Number(process.hrtime.bigint() - started) / 1e6,
        firstByteMs,
        raw,
        server: response.headers.get('server'),
        cfRay: response.headers.get('cf-ray'),
        requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id')
    };
}

function describe(result) {
    if (result.status >= 200 && result.status < 300) {
        let text = '';
        let thinking = 0;
        try {
            const parsed = JSON.parse(result.raw);
            text = (parsed.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ');
            thinking = (parsed.content ?? []).filter(b => b.type === 'thinking').reduce((n, b) => n + (b.thinking ?? '').length, 0);
        } catch { /* raw */ }
        return `OK       thinking_chars=${String(thinking).padStart(4)} text="${text.replace(/\s+/g, ' ').slice(0, 30)}"`;
    }
    let message = result.raw.replace(/\s+/g, ' ');
    try { message = JSON.parse(result.raw).error?.message ?? message; } catch { /* raw */ }
    return `HTTP ${result.status} ${String(message).slice(0, 120)}`;
}

console.log(`model: ${modelId} (${model.adapterModel})  key: ...${String(model.apiKey).slice(-6)}\n`);

// A request with a non-existent model: the docs say a mistyped ID silently
// falls back to K2.8 Preview, so this both measures latency and tests that claim.
async function networkRtt(base) {
    const started = process.hrtime.bigint();
    const response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model: '__no_such_model__', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] })
    });
    const raw = await response.text();
    let answeredBy = null;
    let thinking = 0;
    try {
        const parsed = JSON.parse(raw);
        answeredBy = parsed.model ?? null;
        thinking = (parsed.content ?? []).filter(b => b.type === 'thinking').reduce((n, b) => n + (b.thinking ?? '').length, 0);
    } catch { /* raw */ }
    return {
        status: response.status,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        colo: response.headers.get('cf-ray'),
        server: response.headers.get('server'),
        answeredBy,
        thinking
    };
}

// Streaming: time to the first SSE event (network + prefill) versus completion.
async function streamTiming(base) {
    const started = process.hrtime.bigint();
    const response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ ...JSON.parse(body), max_tokens: 64, stream: true })
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let firstEventMs = null;
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstEventMs == null) firstEventMs = Number(process.hrtime.bigint() - started) / 1e6;
        buffer += decoder.decode(value, { stream: true });
    }
    return {
        status: response.status,
        firstEventMs,
        totalMs: Number(process.hrtime.bigint() - started) / 1e6,
        events: (buffer.match(/^event:/gm) ?? []).length
    };
}

for (const host of hosts) {
    console.log(`-- ${host.label} --`);

    // The response `model` field echoes the request, so a mistyped ID cannot be
    // detected from an answer — /v1/models is the only place the valid IDs are
    // stated. (Docs: a wrong ID silently serves K2.8 Preview without thinking.)
    try {
        const listed = await fetch(`${host.base}/v1/models`, { headers: headers() });
        const payload = await listed.text();
        let ids = [];
        try { ids = (JSON.parse(payload).data ?? []).map(m => m.id); } catch { /* raw */ }
        console.log(`  GET /v1/models http=${listed.status} ids=[${ids.join(', ') || payload.replace(/\s+/g, ' ').slice(0, 100)}]`);
    } catch (error) {
        console.log(`  GET /v1/models ERROR ${error.message}`);
    }

    const samples = [];
    for (let i = 1; i <= rounds; i++) {
        try {
            const result = await timedFetch(`${host.base}/v1/messages`, { method: 'POST', headers: headers(), body });
            samples.push(result.totalMs);
            console.log(`  #${i} ${String(Math.round(result.totalMs)).padStart(6)}ms  server=${result.server ?? '-'}  ${describe(result)}`);
        } catch (error) {
            console.log(`  #${i} ERROR ${error.message}`);
        }
    }
    if (samples.length > 0) {
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        console.log(`  avg ${Math.round(avg)}ms  min ${Math.round(Math.min(...samples))}ms  max ${Math.round(Math.max(...samples))}ms`);
    } else {
        console.log('  no successful sample');
    }

    const rtts = [];
    for (let i = 1; i <= rounds; i++) {
        try {
            const rtt = await networkRtt(host.base);
            rtts.push(rtt.ms);
            console.log(`  unknown-model #${i} ${Math.round(rtt.ms)}ms  http=${rtt.status}  answered_by=${rtt.answeredBy ?? '-'}  thinking_chars=${rtt.thinking}  cf-ray=${rtt.colo ?? '-'}`);
        } catch (error) { console.log(`  rtt ERROR ${error.message}`); }
    }
    if (rtts.length > 0) {
        const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
        console.log(`  round trip (no generation): avg ${Math.round(avg)}ms  min ${Math.round(Math.min(...rtts))}ms`);
    }

    const streams = [];
    for (let i = 1; i <= rounds; i++) {
        try {
            const s = await streamTiming(host.base);
            streams.push(s);
            console.log(`  stream #${i} first_event=${Math.round(s.firstEventMs)}ms total=${Math.round(s.totalMs)}ms events=${s.events} http=${s.status}`);
        } catch (error) {
            console.log(`  stream ERROR ${error.message}`);
        }
    }
    if (streams.length > 0) {
        const avgFirst = streams.reduce((n, s) => n + s.firstEventMs, 0) / streams.length;
        console.log(`  stream first event avg ${Math.round(avgFirst)}ms\n`);
    } else {
        console.log();
    }
}
