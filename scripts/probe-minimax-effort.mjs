/**
 * Probe: does MiniMax M3.1 Flash accept ANY reasoning-effort control?
 *
 * The router drops `reasoning_effort` for a model that declares no
 * `capabilities.thinkingLevels` and warns on every request. Before declaring what the
 * model supports, ask it: does it accept an effort knob, and does it accept thinking
 * disabled/adaptive at all?
 *
 * Run: node scripts/probe-minimax-effort.mjs
 */
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'minimax-m31-flash-chat';
const model = config.models[modelId];

const messages = [{ role: 'user', content: [{ type: 'text', text: 'Say hi in three words.' }] }];

async function probe(label, extra) {
    const body = { model: model.adapterModel, max_tokens: 64, messages, ...extra };
    try {
        const response = await fetch(`${model.endpoint}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(body)
        });
        const raw = await response.text();
        if (response.ok) {
            let thinkingChars = 0;
            try {
                const parsed = JSON.parse(raw);
                thinkingChars = (parsed.content ?? [])
                    .filter(b => b.type === 'thinking')
                    .reduce((n, b) => n + (b.thinking ?? '').length, 0);
            } catch { /* raw is enough */ }
            console.log(`ACCEPT   ${label.padEnd(42)} thinking_block_chars=${thinkingChars}`);
        } else {
            let message = raw.replace(/\s+/g, ' ');
            try { message = JSON.parse(raw).error?.message ?? message; } catch { /* raw */ }
            console.log(`REJECT   ${label.padEnd(42)} ${String(message).slice(0, 140)}`);
        }
    } catch (error) {
        console.log(`ERROR    ${label.padEnd(42)} ${error.message.slice(0, 140)}`);
    }
}

console.log(`model: ${modelId}  (${model.adapterModel})\n`);

await probe('baseline (nothing sent)', {});
await probe('output_config.effort = low', { output_config: { effort: 'low' } });
await probe('output_config.effort = high', { output_config: { effort: 'high' } });
await probe('output_config.effort = max', { output_config: { effort: 'max' } });
await probe('thinking = {type: adaptive}', { thinking: { type: 'adaptive' } });
await probe('thinking = {type: disabled}', { thinking: { type: 'disabled' } });
await probe('thinking = enabled, budget 1024', { thinking: { type: 'enabled', budget_tokens: 1024 } });
await probe('output_config.effort = medium', { output_config: { effort: 'medium' } });
await probe('output_config.effort = minimal', { output_config: { effort: 'minimal' } });
await probe('output_config.effort = xhigh', { output_config: { effort: 'xhigh' } });
await probe('output_config.effort = none', { output_config: { effort: 'none' } });
