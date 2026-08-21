// Probe: what thinking/output_config shapes does DeepSeek's Anthropic endpoint accept?
// Goal: find the exact combination that avoids "missing thinking parameter"
// while still controlling effort. Non-streaming, tiny max_tokens to stay cheap.
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const model = config.models['deepseek-chat'];
const endpoint = model.endpoint;
const apiKey = model.apiKey;
const adapterModel = model.adapterModel;

const base = {
  model: adapterModel,
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
};

const cases = [
  { name: 'A: baseline (no thinking/output_config)', body: {} },
  { name: 'B: output_config.effort only (current gateway)', body: { output_config: { effort: 'low' } } },
  { name: 'C: thinking enabled only', body: { thinking: { type: 'enabled', budget_tokens: 48 } } },
  { name: 'D: thinking adaptive only', body: { thinking: { type: 'adaptive' } } },
  { name: 'E: thinking adaptive + output_config.effort (Claude 4.6+ shape)', body: { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } } },
  { name: 'F: thinking enabled + output_config.effort', body: { thinking: { type: 'enabled', budget_tokens: 48 }, output_config: { effort: 'low' } } },
  { name: 'G: reasoning.effort only', body: { reasoning: { effort: 'low' } } },
  { name: 'H: thinking disabled only', body: { thinking: { type: 'disabled' } } },
];

for (const c of cases) {
  const payload = JSON.stringify({ ...base, ...c.body });
  try {
    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: payload
    });
    const text = await res.text();
    console.log(`${c.name}\n  status=${res.status}  ${text.slice(0, 200).replace(/\n/g, ' ')}\n`);
  } catch (e) {
    console.log(`${c.name}\n  FETCH ERROR: ${e.message}\n`);
  }
}
