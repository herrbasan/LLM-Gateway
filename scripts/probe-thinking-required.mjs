/**
 * Probe: is DeepSeek's "thinking must be passed back" requirement structural or
 * semantic?
 *
 * If it is structural — the field must be present — then a turn whose thinking we
 * never captured (produced by another adapter, or cached under a different id) can
 * still be echoed honestly, as an empty thinking block, instead of killing the
 * session with a 400 that repeats on every resend. If it is semantic — the real
 * reasoning is required — the only cure is dropping the turn.
 *
 * Sends raw Anthropic-protocol requests straight to the endpoint. No gateway.
 *
 * Run: node scripts/probe-thinking-required.mjs [modelId]
 */
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'deepseek-flash-chat';
const model = config.models[modelId];

const TOOLS = [{
    name: 'ping',
    description: 'Ping a host',
    input_schema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] }
}];

const text = (t) => ({ type: 'text', text: t });
const call = (id) => ({ type: 'tool_use', id, name: 'ping', input: { host: 'a' } });
const result = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'pong' });
const thinking = (t) => ({ type: 'thinking', thinking: t });

const CASES = [
    { name: 'control: thinking with content', messages: [
        { role: 'user', content: [text('Ping host a.')] },
        { role: 'assistant', content: [thinking('I will ping host a.'), call('c1')] },
        { role: 'user', content: [result('c1')] }
    ] },
    { name: 'control: NO thinking block', messages: [
        { role: 'user', content: [text('Ping host a.')] },
        { role: 'assistant', content: [call('c2')] },
        { role: 'user', content: [result('c2')] }
    ] },
    { name: 'EMPTY thinking block', messages: [
        { role: 'user', content: [text('Ping host a.')] },
        { role: 'assistant', content: [thinking(''), call('c3')] },
        { role: 'user', content: [result('c3')] }
    ] },
    { name: 'EMPTY thinking block + signature null', messages: [
        { role: 'user', content: [text('Ping host a.')] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: null }, call('c4')] },
        { role: 'user', content: [result('c4')] }
    ] },
    { name: 'single space thinking block', messages: [
        { role: 'user', content: [text('Ping host a.')] },
        { role: 'assistant', content: [thinking(' '), call('c5')] },
        { role: 'user', content: [result('c5')] }
    ] }
];

for (const testCase of CASES) {
    const body = { model: model.adapterModel, max_tokens: 64, messages: testCase.messages, tools: TOOLS };
    let outcome;
    try {
        const response = await fetch(`${model.endpoint}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(body)
        });
        const raw = await response.text();
        let detail = raw.replace(/\s+/g, ' ').slice(0, 200);
        if (response.ok) {
            try { detail = `ok (stop_reason=${JSON.parse(raw).stop_reason ?? '?'})`; } catch { /* raw is fine */ }
        }
        outcome = `${response.status === 200 ? 'ACCEPT' : 'REJECT'} ${response.status}  ${detail}`;
    } catch (error) {
        outcome = `threw: ${error.message.slice(0, 160)}`;
    }
    console.log(`${testCase.name.padEnd(38)} ${outcome}`);
}
