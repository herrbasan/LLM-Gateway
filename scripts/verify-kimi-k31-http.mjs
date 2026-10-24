/**
 * Verify the restarted gateway serves Kimi K3.1 Pro for the payload the chat
 * client actually sends when thinking is switched off.
 *
 * This goes through HTTP (the real route), not the router directly, so it also
 * covers the SSE path: the gateway withholds headers until a chunk carries
 * something the client renders, and a 400 from upstream would surface as a JSON
 * error body instead of a stream.
 *
 * The access key is read from .env / config and never printed.
 *
 * Run: node scripts/verify-kimi-k31-http.mjs
 */
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const config = JSON.parse(fs.readFileSync(new URL('config.json', root), 'utf8'));

function accessKey() {
    if (config.accessKey) return String(config.accessKey).trim();
    const envFile = new URL('.env', root);
    if (fs.existsSync(envFile)) {
        for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
            const match = line.match(/^\s*GATEWAY_ACCESS_KEY\s*=\s*(.+?)\s*$/);
            if (match) return match[1].replace(/^["']|["']$/g, '');
        }
    }
    return process.env.GATEWAY_ACCESS_KEY ?? null;
}

const key = accessKey();
if (!key) throw new Error('No gateway access key found in config.json, .env or environment');

const base = `http://127.0.0.1:${config.port ?? 3400}`;
const model = process.argv[2] || 'kimi-k31-chat';
const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
const messages = [{ role: 'user', content: 'Say hi in three words.' }];

async function nonStreaming(label, extra) {
    const started = Date.now();
    const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, max_tokens: 512, stream: false, ...extra })
    });
    const raw = await response.text();
    const ms = Date.now() - started;
    if (!response.ok) {
        console.log(`FAIL  ${label.padEnd(36)} ${String(ms).padStart(5)}ms http=${response.status} ${raw.replace(/\s+/g, ' ').slice(0, 200)}`);
        process.exitCode = 1;
        return;
    }
    const parsed = JSON.parse(raw);
    const message = parsed.choices?.[0]?.message ?? {};
    const thinking = message.reasoning_content ?? '';
    const text = String(message.content ?? '').replace(/\s+/g, ' ').slice(0, 40);
    console.log(`PASS  ${label.padEnd(36)} ${String(ms).padStart(5)}ms thinking_chars=${String(thinking.length).padStart(4)} finish=${parsed.choices?.[0]?.finish_reason} text="${text}"`);
}

async function streaming(label, extra) {
    const started = Date.now();
    const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, max_tokens: 512, stream: true, ...extra })
    });
    if (!response.ok) {
        const raw = await response.text();
        console.log(`FAIL  ${label.padEnd(36)} http=${response.status} ${raw.replace(/\s+/g, ' ').slice(0, 200)}`);
        process.exitCode = 1;
        return;
    }
    const raw = await response.text();
    const ms = Date.now() - started;
    const deltas = (raw.match(/"reasoning_content"\s*:\s*"[^"]+"/g) ?? []).length;
    const reasonings = [...raw.matchAll(/"reasoning_content"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).join('');
    const contents = [...raw.matchAll(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).join('');
    const finished = /"finish_reason"\s*:\s*"stop"/.test(raw);
    const ok = finished && contents.length > 0 && reasonings.length > 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(36)} ${String(ms).padStart(5)}ms deltas=${String(deltas).padStart(3)} thinking_chars=${String(reasonings.length).padStart(4)} text="${contents.replace(/\\n/g, ' ').slice(0, 40)}"`);
    if (!ok) process.exitCode = 1;
}

const health = await fetch(`${base}/health`);
const healthBody = await health.text();
console.log(`health: http=${health.status} ${healthBody.replace(/\s+/g, ' ').slice(0, 120)}`);

const models = await fetch(`${base}/v1/models`, { headers });
const listed = await models.json();
const ids = (listed.data ?? []).map(m => m.id);
console.log(`/v1/models: ${ids.includes(model) ? 'lists' : 'MISSING'} ${model}  (${ids.length} models)\n`);

console.log('-- the payload chat sends when thinking is off --');
await nonStreaming('effort=none + enable_thinking=false', { reasoning_effort: 'none', enable_thinking: false });
await nonStreaming('enable_thinking=false', { enable_thinking: false });
await streaming('stream: effort=none + thinking=false', { reasoning_effort: 'none', enable_thinking: false });

console.log('\n-- declared effort levels --');
await nonStreaming('reasoning_effort=low', { reasoning_effort: 'low' });
await nonStreaming('reasoning_effort=max', { reasoning_effort: 'max' });
await streaming('stream: reasoning_effort=low', { reasoning_effort: 'low' });
