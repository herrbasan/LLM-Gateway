// Smoke test: claude-fable-chat thinking translation after gateway restart.
// Sends one request per thinking state and reports HTTP status + short excerpt.
// Usage: node scripts/test_fable_thinking.mjs
// Requires GATEWAY_ACCESS_KEY from .env (same source the gateway middleware uses).

import { readFileSync } from 'node:fs';

const accessKey = readFileSync('.env', 'utf8')
    .split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith('GATEWAY_ACCESS_KEY='))
    ?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

if (!accessKey) {
    console.error('FAIL: GATEWAY_ACCESS_KEY not found in .env');
    process.exit(1);
}

const states = [
    { name: 'omitted', body: {} },
    { name: 'disabled', body: { enable_thinking: false } },
    { name: 'enabled', body: { enable_thinking: true } },
];

for (const { name, body } of states) {
    const payload = {
        model: 'claude-fable-chat',
        stream: false,
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        max_tokens: 32,
        ...body,
    };

    const res = await fetch('http://localhost:3400/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessKey}`,
        },
        body: JSON.stringify(payload),
    });

    const text = await res.text();
    let excerpt = text.slice(0, 200).replace(/\s+/g, ' ');
    let tag = res.ok ? 'PASS' : 'FAIL';
    console.log(`[${tag}] thinking ${name.padEnd(9)} → HTTP ${res.status}  ${excerpt}`);
}
