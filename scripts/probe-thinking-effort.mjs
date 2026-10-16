/**
 * Probe: does DeepSeek emit a thinking block at all when the request carries
 * `output_config.effort`?
 *
 * The adapter only caches a turn's thinking when the stream actually reported some
 * (`thinkingText || thinkingSignature`). Real traffic pins `reasoning_effort: "low"`
 * on this model, so if effort mode yields no thinking block the cache stays empty
 * for those turns — and the next request, which DeepSeek requires to echo that
 * thinking, cannot be satisfied from anything but an empty block.
 *
 * Run: node scripts/probe-thinking-effort.mjs [modelId]
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

async function run(label, extra) {
    const body = {
        model: model.adapterModel,
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Ping host a. You must use the ping tool.' }] }],
        tools: TOOLS,
        ...extra
    };
    const response = await fetch(`${model.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': model.apiKey,
            'anthropic-version': '2023-06-01',
            accept: 'text/event-stream'
        },
        body: JSON.stringify(body)
    });
    const raw = await response.text();
    const counts = {};
    for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let event;
        try { event = JSON.parse(line.replace(/^data:\s*/, '')); } catch { continue; }
        const key = event.type === 'content_block_delta' ? `${event.type}:${event.delta?.type}` : event.type;
        counts[key] = (counts[key] || 0) + 1;
    }
    console.log(`\n${label}  (HTTP ${response.status})`);
    console.log(`  thinking blocks started: ${counts['content_block_start:undefined'] ?? 0} (see below)`);
    console.log(`  thinking_delta events:   ${counts['content_block_delta:thinking_delta'] ?? 0}`);
    console.log(`  signature_delta events:  ${counts['content_block_delta:signature_delta'] ?? 0}`);
    console.log(`  tool_use blocks:         ${raw.split('"type":"tool_use"').length - 1}`);
    console.log(`  event types: ${JSON.stringify(counts)}`);
}

await run('effort: low (what real traffic sends)', { output_config: { effort: 'low' } });
await run('thinking enabled, no effort (adapter default path)', { thinking: { type: 'enabled', budget_tokens: 512 } });
