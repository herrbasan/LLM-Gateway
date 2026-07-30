// One-shot verification: a long-thinking stream must survive past 120s wall time.
// Before the first-byte-signal fix, the gateway killed any stream at 120s with code 23.
import { readFileSync } from 'node:fs';

let key = null;
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  if (t.slice(0, i).trim() === 'GATEWAY_ACCESS_KEY') {
    key = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    break;
  }
}
if (!key) { console.log('NO GATEWAY_ACCESS_KEY in .env'); process.exit(1); }

const start = Date.now();
const el = () => ((Date.now() - start) / 1000).toFixed(1) + 's';

const body = JSON.stringify({
  model: 'deepseek-chat',
  stream: true,
  max_tokens: 16000,
  messages: [{ role: 'user', content: 'Think step by step at great length, then write a long detailed answer. Task: determine whether 104729 is prime by checking divisibility by every prime up to its square root, narrating each check explicitly and verbosely. Then, after concluding, write an exhaustive multi-paragraph essay on the history and applications of primality testing. Take your time; be maximally thorough and do not stop early.' }]
});

console.log('Sending long-thinking request (target: exceed 120s)...');
const res = await fetch('http://localhost:3400/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
  body
});
console.log('HEADERS at', el(), 'status', res.status);
if (!res.ok) { console.log('ERR BODY:', (await res.text()).slice(0, 300)); process.exit(0); }

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '', last = Date.now(), thinking = 0, content = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines) {
    if (!l.startsWith('data:')) continue;
    const d = l.slice(5).trim();
    if (d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      const delta = j.choices?.[0]?.delta;
      if (delta?.reasoning_content) thinking++;
      if (delta?.content) content++;
    } catch {}
  }
  const now = Date.now();
  if (now - last > 30000) { console.log('  ...streaming at', el(), `(thinking:${thinking} content:${content})`); last = now; }
}
const totalMs = Date.now() - start;
console.log('STREAM COMPLETED at', el(), `— thinking:${thinking} content:${content}`);
console.log(totalMs > 120000 ? '>>> SURVIVED past 120s: old bug is DEAD' : `>>> finished under 120s (${(totalMs / 1000).toFixed(0)}s) — INCONCLUSIVE`);
