// Probe: confirm DeepSeek's tool-call thinking round-trip requirement.
// Turn 1: send a tool definition, get thinking + tool_use.
// Turn 2a: echo assistant thinking + tool_use + tool_result -> expect 200.
// Turn 2b: echo assistant tool_use WITHOUT thinking + tool_result -> expect 400.
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const model = config.models['deepseek-chat'];
const endpoint = model.endpoint;
const apiKey = model.apiKey;
const adapterModel = model.adapterModel;

const tools = [{
  name: 'get_weather',
  description: 'Get the weather',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
}];

async function post(messages, label) {
  const body = JSON.stringify({
    model: adapterModel,
    max_tokens: 256,
    thinking: { type: 'enabled', budget_tokens: 128 },
    tools,
    messages
  });
  const res = await fetch(`${endpoint}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body
  });
  const text = await res.text();
  console.log(`--- ${label} ---`);
  console.log(`status=${res.status}`);
  console.log(text.slice(0, 700).replace(/\n/g, ' '));
  console.log();
  return JSON.parse(text);
}

// Turn 1: force a tool call
const turn1 = await post([{ role: 'user', content: 'Use the weather tool for Paris.' }], 'TURN 1 (tool call)');

if (turn1.error) { console.log('TURN 1 FAILED:', JSON.stringify(turn1.error)); process.exit(0); }

const thinkingBlocks = turn1.content.filter(b => b.type === 'thinking');
const toolUses = turn1.content.filter(b => b.type === 'tool_use');
console.log(`turn1 blocks: thinking=${thinkingBlocks.length} tool_use=${toolUses.length}\n`);
if (toolUses.length === 0) { console.log('No tool_use produced — model ignored the tool. Aborting.'); process.exit(0); }

const toolUse = toolUses[0];

// Turn 2a: WITH thinking echoed (the fix)
await post([
  { role: 'user', content: 'Use the weather tool for Paris.' },
  { role: 'assistant', content: [...thinkingBlocks, toolUse] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Sunny, 21C' }] }
], 'TURN 2a (thinking echoed)');

// Turn 2b: WITHOUT thinking echoed (reproduces the bug)
await post([
  { role: 'user', content: 'Use the weather tool for Paris.' },
  { role: 'assistant', content: [toolUse] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Sunny, 21C' }] }
], 'TURN 2b (thinking OMITTED)');

// Turn 2c: thinking text echoed WITHOUT signature
await post([
  { role: 'user', content: 'Use the weather tool for Paris.' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: thinkingBlocks[0].thinking }, toolUse] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Sunny, 21C' }] }
], 'TURN 2c (thinking text, NO signature)');

// Turn 2d: thinking echoed with WRONG signature
await post([
  { role: 'user', content: 'Use the weather tool for Paris.' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: thinkingBlocks[0].thinking, signature: 'msg_wrong_signature' }, toolUse] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Sunny, 21C' }] }
], 'TURN 2d (thinking text, WRONG signature)');
