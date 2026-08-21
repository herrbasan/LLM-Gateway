// Reproduce the gateway's exact DeepSeek request shape and find the 400 trigger.
// Gateway uses: Authorization: Bearer, output_config.effort (from reasoning_effort="low"),
// stream: true, and a tool-call continuation where reasoning_content is NOT echoed.
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

async function streamRequest(messages, label) {
  const body = JSON.stringify({
    model: adapterModel,
    max_tokens: 512,
    stream: true,
    output_config: { effort: 'low' },
    tools,
    messages
  });
  const res = await fetch(`${endpoint}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body
  });
  console.log(`--- ${label} ---  status=${res.status}`);
  const text = await res.text();
  if (!res.ok) {
    console.log(text.slice(0, 400));
    console.log();
    return null;
  }
  // Parse SSE to reconstruct the assistant message content blocks.
  const blocks = [];
  let currentBlock = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    let ev;
    try { ev = JSON.parse(payload); } catch { continue; }
    if (ev.type === 'content_block_start') {
      currentBlock = ev.content_block;
      blocks.push(currentBlock);
    } else if (ev.type === 'content_block_delta') {
      if (currentBlock) {
        if (ev.delta?.type === 'thinking_delta') currentBlock.thinking = (currentBlock.thinking || '') + (ev.delta.thinking || '');
        if (ev.delta?.type === 'text_delta') currentBlock.text = (currentBlock.text || '') + (ev.delta.text || '');
        if (ev.delta?.type === 'input_json_delta') currentBlock.input_json = (currentBlock.input_json || '') + (ev.delta.partial_json || '');
      }
    }
  }
  console.log('blocks:', blocks.map(b => ({ type: b.type, id: b.id, name: b.name, thinking: b.thinking?.slice(0, 40), signature: b.signature, input_json: b.input_json })));
  console.log();
  return blocks;
}

// Turn 1: force a tool call (streaming, output_config, Bearer)
const turn1 = await streamRequest([{ role: 'user', content: 'Use the weather tool for Paris.' }], 'TURN 1 streaming');
if (!turn1) process.exit(0);
const thinking = turn1.find(b => b.type === 'thinking');
const toolUse = turn1.find(b => b.type === 'tool_use');
if (!toolUse) { console.log('No tool_use produced. Aborting.'); process.exit(0); }
if (toolUse.input_json) toolUse.input = JSON.parse(toolUse.input_json);
toolUse.type = 'tool_use';

// Turn 2: tool_use WITHOUT thinking echoed (the gateway's actual behavior on tool-call turns)
await streamRequest([
  { role: 'user', content: 'Use the weather tool for Paris.' },
  { role: 'assistant', content: [toolUse] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Sunny, 21C' }] }
], 'TURN 2 streaming (tool_use, no thinking echoed)');

// Turn 3: tool_use WITH thinking echoed (the proposed fix)
await streamRequest([
  { role: 'user', content: 'Use the weather tool for Paris.' },
  { role: 'assistant', content: [thinking, toolUse] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Sunny, 21C' }] }
], 'TURN 3 streaming (thinking + tool_use echoed)');
