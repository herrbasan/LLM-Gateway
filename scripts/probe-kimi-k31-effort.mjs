/**
 * Probe: what thinking control does Kimi K3.1 Pro actually accept?
 *
 * Docs (https://www.kimi.com/code/docs/en/kimi-code/models.html, read 2026-10-23)
 * claim: effort low/high/max (default max), thinking cannot be disabled, and
 * `medium` maps to `high`. The gateway's config declared `none` among the levels,
 * which is what produced `400 K3.1 Pro does not support disabled thinking mode`.
 * Declaring a level is a claim, so measure it rather than trusting either the docs
 * or the previous session's memory note (which said low/medium/max).
 *
 * Run: node scripts/probe-kimi-k31-effort.mjs [modelId]
 */
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'kimi-k31-chat';
const model = config.models[modelId];

const messages = [{ role: 'user', content: [{ type: 'text', text: 'Say hi in three words.' }] }];

async function probe(label, extra) {
    const body = { model: model.adapterModel, max_tokens: 256, messages, ...extra };
    try {
        const response = await fetch(`${model.endpoint}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(body)
        });
        const raw = await response.text();
        if (response.ok) {
            let thinkingChars = 0;
            let text = '';
            try {
                const parsed = JSON.parse(raw);
                thinkingChars = (parsed.content ?? [])
                    .filter(b => b.type === 'thinking')
                    .reduce((n, b) => n + (b.thinking ?? '').length, 0);
                text = (parsed.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ');
            } catch { /* raw is enough */ }
            console.log(`ACCEPT   ${label.padEnd(38)} thinking_chars=${String(thinkingChars).padStart(5)}  text="${text.replace(/\s+/g, ' ').slice(0, 40)}"`);
        } else {
            let message = raw.replace(/\s+/g, ' ');
            try { message = JSON.parse(raw).error?.message ?? message; } catch { /* raw */ }
            console.log(`REJECT   ${label.padEnd(38)} http=${response.status} ${String(message).slice(0, 150)}`);
        }
    } catch (error) {
        console.log(`ERROR    ${label.padEnd(38)} ${error.message.slice(0, 150)}`);
    }
}

console.log(`model: ${modelId}  (${model.adapterModel})  endpoint: ${model.endpoint}\n`);

await probe('baseline (nothing sent)', {});
await probe('output_config.effort = low', { output_config: { effort: 'low' } });
await probe('output_config.effort = medium', { output_config: { effort: 'medium' } });
await probe('output_config.effort = high', { output_config: { effort: 'high' } });
await probe('output_config.effort = max', { output_config: { effort: 'max' } });
await probe('output_config.effort = xhigh', { output_config: { effort: 'xhigh' } });
await probe('output_config.effort = none', { output_config: { effort: 'none' } });
await probe('reasoning_effort = low (top level)', { reasoning_effort: 'low' });
await probe('reasoning_effort = none (top level)', { reasoning_effort: 'none' });
await probe('thinking = {type: disabled}', { thinking: { type: 'disabled' } });
await probe('thinking = {type: adaptive}', { thinking: { type: 'adaptive' } });
await probe('thinking = enabled, budget 1024', { thinking: { type: 'enabled', budget_tokens: 1024 } });
await probe('effort low + thinking disabled', { output_config: { effort: 'low' }, thinking: { type: 'disabled' } });
