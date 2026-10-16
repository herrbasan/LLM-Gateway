/**
 * Probe: does each anthropic-protocol provider accept an EMPTY thinking block on a
 * tool-call continuation?
 *
 * The placeholder only helps where the provider's requirement is structural. If a
 * provider rejects an empty block, injecting one would replace a missing-thinking
 * 400 with an empty-thinking 400 — same dead session, worse diagnosis. Probed per
 * provider before the fallback is allowed to fire for it.
 *
 * Run: node scripts/probe-empty-thinking.mjs [modelId ...]
 */
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelIds = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ['deepseek-flash-chat', 'deepseek-chat', 'kimi-k3-chat', 'kimi-k3-256k-chat', 'kimi-code-chat'];

const TOOLS = [{
    name: 'ping',
    description: 'Ping a host',
    input_schema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] }
}];

const text = (t) => ({ type: 'text', text: t });
const call = (id) => ({ type: 'tool_use', id, name: 'ping', input: { host: 'a' } });
const result = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'pong' });

async function probe(model, messages) {
    const body = { model: model.adapterModel, max_tokens: 64, messages, tools: TOOLS };
    if (model.reasoning_effort) body.output_config = { effort: model.reasoning_effort };
    const response = await fetch(`${model.endpoint}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
    });
    const raw = await response.text();
    if (response.ok) return 'ACCEPT';
    try {
        return `REJECT ${response.status}: ${JSON.parse(raw).error?.message ?? raw.slice(0, 120)}`;
    } catch {
        return `REJECT ${response.status}: ${raw.replace(/\s+/g, ' ').slice(0, 120)}`;
    }
}

for (const modelId of modelIds) {
    const model = config.models[modelId];
    if (!model) { console.log(`${modelId}: not in config.json`); continue; }
    const withEmpty = await probe(model, [
        { role: 'user', content: [text('Ping host a.')] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, call('probe_a')] },
        { role: 'user', content: [result('probe_a')] }
    ]);
    const withReal = await probe(model, [
        { role: 'user', content: [text('Ping host a.')] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Pinging host a.' }, call('probe_b')] },
        { role: 'user', content: [result('probe_b')] }
    ]);
    console.log(`\n${modelId}  (${model.adapterModel})`);
    console.log(`  empty thinking block: ${withEmpty}`);
    console.log(`  real  thinking block: ${withReal}`);
}
