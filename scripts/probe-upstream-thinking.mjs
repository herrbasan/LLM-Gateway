// Measure: does deepseek (Anthropic endpoint) stream thinking chunks progressively,
// or buffer server-side and send headers+everything at once?
// We bypass the gateway and hit the upstream directly to see raw timing.
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const model = config.models['deepseek-chat'];
const endpoint = model.endpoint;
const apiKey = model.apiKey;
const adapterModel = model.adapterModel;

const prompt = 'Think very carefully and at length. Derive whether 104729 is prime, checking divisibility step by step. Take your time and show detailed reasoning.';

const body = JSON.stringify({
  model: adapterModel,
  max_tokens: 4000,
  stream: true,
  thinking: { type: 'enabled', budget_tokens: 3000 },
  messages: [{ role: 'user', content: prompt }]
});

const start = Date.now();
const el = () => Date.now() - start;

console.log(`POST ${endpoint}/v1/messages  model=${adapterModel}`);
const res = await fetch(`${endpoint}/v1/messages`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Accept': 'text/event-stream'
  },
  body
});

console.log(`HEADERS at ${el()}ms  status=${res.status} ctype=${res.headers.get('content-type')}`);
if (!res.ok) {
  console.log('ERR BODY:', (await res.text()).slice(0, 400));
  process.exit(0);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let events = 0;
let firstDataAt = null;
let lastAt = null;
let thinkingEvents = 0;
let textEvents = 0;
const gaps = [];

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const now = el();
  if (firstDataAt === null) firstDataAt = now;
  if (lastAt !== null && now - lastAt > 5000) gaps.push(now - lastAt);
  lastAt = now;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    events++;
    try {
      const obj = JSON.parse(line.slice(5).trim());
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'thinking_delta') thinkingEvents++;
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') textEvents++;
    } catch {}
  }
}

console.log(`FIRST DATA at ${firstDataAt}ms | DONE at ${el()}ms`);
console.log(`events=${events} thinkingDeltas=${thinkingEvents} textDeltas=${textEvents}`);
console.log(`gaps>5s during stream: ${gaps.length ? gaps.join(', ') + 'ms' : 'none'}`);
