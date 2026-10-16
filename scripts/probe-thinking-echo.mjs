/**
 * Probe: which client history shape makes DeepSeek refuse with
 * "The `content[].thinking` in the thinking mode must be passed back to the API"?
 *
 * DeepSeek requires the assistant's thinking on a tool-call continuation. A client
 * does not round-trip it, so the adapter answers with `injectCachedThinking` and
 * with the client's own `reasoning_content` where it is present. This runs the
 * shapes against the LIVE gateway (127.0.0.1:3400) so what is tested is what is
 * deployed, and reports the upstream's answer for each.
 *
 * Run: node scripts/probe-thinking-echo.mjs
 */
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

let key = null;
try {
    for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
        const t = line.trim();
        if (t.startsWith('GATEWAY_ACCESS_KEY')) key = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    }
} catch { /* fall back to config */ }
key = key || config.accessKey;

const GATEWAY = 'http://127.0.0.1:3400';
const MODEL = 'deepseek-flash-chat';

const TOOLS = [{
    type: 'function',
    function: {
        name: 'ping',
        description: 'Ping a host',
        parameters: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] }
    }
}];

// An id whose thinking is already cached on disk by probe-thinking-cache.mjs.
const CACHED_ID = process.argv[2] || 'call_00_grDnGm8rP7AhdfZlxSuE5135';

const call = (id) => ({ id, type: 'function', function: { name: 'ping', arguments: '{"host":"a"}' } });

const CASES = [
    {
        name: 'assistant echoes reasoning_content + tool_calls',
        messages: [
            { role: 'user', content: 'Ping host a.' },
            { role: 'assistant', content: '', reasoning_content: 'The user wants a ping.', tool_calls: [call('call_probe_echo')] },
            { role: 'tool', tool_call_id: 'call_probe_echo', content: 'pong' }
        ]
    },
    {
        name: 'assistant has tool_calls, no reasoning, id IS cached',
        messages: [
            { role: 'user', content: 'Ping host a.' },
            { role: 'assistant', content: '', tool_calls: [call(CACHED_ID)] },
            { role: 'tool', tool_call_id: CACHED_ID, content: 'pong' }
        ]
    },
    {
        name: 'assistant has tool_calls, no reasoning, id is NOT cached',
        messages: [
            { role: 'user', content: 'Ping host a.' },
            { role: 'assistant', content: '', tool_calls: [call('call_probe_uncached')] },
            { role: 'tool', tool_call_id: 'call_probe_uncached', content: 'pong' }
        ]
    },
    {
        name: 'assistant reasoning + tool_calls, with an image earlier (array content path)',
        messages: [
            { role: 'user', content: 'Ping host a.' },
            { role: 'assistant', content: '', tool_calls: [call('call_probe_img')] },
            { role: 'tool', tool_call_id: 'call_probe_img', content: 'pong' },
            { role: 'user', content: 'Now ping host b.' }
        ]
    }
];

for (const testCase of CASES) {
    let outcome;
    try {
        const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: MODEL, messages: testCase.messages, tools: TOOLS, max_tokens: 64, stream: false })
        });
        const text = await res.text();
        let detail = text.replace(/\s+/g, ' ').slice(0, 260);
        if (res.ok) {
            try {
                const parsed = JSON.parse(text);
                detail = `ok — ${JSON.stringify(parsed.choices?.[0]?.finish_reason ?? '?')}`;
            } catch { /* keep the raw body */ }
        }
        outcome = `HTTP ${res.status}  ${detail}`;
    } catch (error) {
        outcome = `threw: ${error.message.slice(0, 160)}`;
    }
    console.log(`\n${testCase.name}\n  ${outcome}`);
}
