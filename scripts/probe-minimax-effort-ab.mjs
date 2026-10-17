/**
 * A/B: does effort change thinking volume on MiniMax M3 when adaptive is enabled?
 *
 * The scaling probe showed a rising trend with heavy variance (low 88/296,
 * max 426/622). That is not enough to declare a scale from. This repeats one level at
 * a time, several runs each, and reports the median — if low and max overlap, effort
 * is not demonstrably driving anything here.
 *
 * Run: node scripts/probe-minimax-effort-ab.mjs [modelId]
 */
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'minimax-m3-chat';
const model = config.models[modelId];

const PROMPT = 'A bat and a ball cost 1.10 together. The bat costs 1.00 more than the ball. '
    + 'What does the ball cost? Think it through, then answer with the number.';

async function thinkingChars(extra) {
    const response = await fetch(`${model.endpoint}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
            model: model.adapterModel,
            max_tokens: 2048,
            messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
            ...extra
        })
    });
    const raw = await response.text();
    if (!response.ok) return `reject ${response.status}`;
    const parsed = JSON.parse(raw);
    return (parsed.content ?? []).filter(b => b.type === 'thinking')
        .reduce((n, b) => n + (b.thinking ?? '').length, 0);
}

const median = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const CASES = [
    ['adaptive only', { thinking: { type: 'adaptive' } }],
    ['adaptive + low', { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }],
    ['adaptive + max', { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }]
];

const RUNS = Number(process.argv[3] || 5);
console.log(`model: ${modelId}  runs per case: ${RUNS}\n`);

for (const [label, extra] of CASES) {
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
        try {
            samples.push(await thinkingChars(extra));
        } catch (error) {
            samples.push(error.message.slice(0, 20));
        }
    }
    const numbers = samples.filter(s => typeof s === 'number');
    console.log(`${label.padEnd(16)} median=${String(median(numbers)).padStart(5)}  samples=[${samples.join(', ')}]`);
}
