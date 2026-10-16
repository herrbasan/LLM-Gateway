/**
 * Probe: does a streaming tool call through the anthropic adapter populate the
 * thinking cache?
 *
 * DeepSeek requires the assistant's thinking block to be echoed back on a
 * tool-call continuation ("The `content[].thinking` in the thinking mode must be
 * passed back to the API"), and clients do not round-trip it. The adapter's
 * answer is the cache keyed by tool_use id: saved when the stream reported
 * thinking alongside a tool call, replayed by injectCachedThinking on the next
 * turn. If nothing is saved, every continuation of that turn is a 400.
 *
 * Run: node scripts/probe-thinking-cache.mjs [modelId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createAnthropicAdapter } from '../src/adapters/anthropic.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'deepseek-flash-chat';
const modelConfig = config.models[modelId];

const TOOLS = [{
    type: 'function',
    function: {
        name: 'ping',
        description: 'Ping a host',
        parameters: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] }
    }
}];

const dir = path.join(process.cwd(), 'logs', 'anthropic-thinking');
const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);

console.log(`model: ${modelId}  (${modelConfig.adapterModel} @ ${modelConfig.endpoint})`);
console.log(`cache files before: ${before.size}`);

const adapter = createAnthropicAdapter();
const chunks = [];
try {
    for await (const chunk of adapter.streamComplete(modelConfig, {
        messages: [{ role: 'user', content: 'Ping host a. You must use the ping tool.' }],
        tools: TOOLS,
        maxTokens: 1024,
        stream: true
    })) {
        chunks.push(chunk);
    }
} catch (error) {
    console.log(`stream threw: ${error.message.slice(0, 200)}`);
}

const reasoning = chunks.map(c => c.choices?.[0]?.delta?.reasoning_content ?? '').join('');
const calls = chunks
    .flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? [])
    .filter(tc => tc.id);
const finish = chunks.find(c => c.choices?.[0]?.finish_reason)?.choices?.[0]?.finish_reason ?? null;

console.log(`\nreasoning chars delivered: ${reasoning.length}`);
console.log(`tool calls: ${JSON.stringify(calls.map(tc => ({ id: tc.id, name: tc.function?.name })))}`);
console.log(`finish_reason: ${finish}`);

const after = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
const added = after.filter(name => !before.has(name));
console.log(`\ncache files after: ${after.length}`);
console.log(`added by this run: ${JSON.stringify(added)}`);

if (calls.length > 0 && added.length === 0) {
    console.log('\nFINDING: the turn produced a tool call, but nothing was cached for it.');
    console.log('A continuation of this turn cannot carry its thinking, so DeepSeek 400s.');
} else if (added.length > 0) {
    const sample = JSON.parse(fs.readFileSync(path.join(dir, added[0]), 'utf8'));
    console.log(`\ncached payload for ${added[0]}: thinking=${sample.thinking.length} chars, signature=${sample.signature ? 'present' : 'null'}`);
}
