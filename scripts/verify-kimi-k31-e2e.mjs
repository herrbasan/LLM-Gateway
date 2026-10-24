/**
 * Verify the fixed path end to end: the client's thinking-off request must not
 * turn into `thinking: { type: "disabled" }` for Kimi K3.1 Pro.
 *
 * The gateway-chat client sends BOTH fields when a user turns thinking off:
 * `reasoning_effort: "none"` and `enable_thinking: false`. That combination
 * produced `400 K3.1 Pro does not support disabled thinking mode` until
 * 2026-10-23, because the config declared `none` among the model's levels.
 *
 * Run: node scripts/verify-kimi-k31-e2e.mjs
 */
import fs from 'node:fs';
import { ModelRouter } from '../src/core/model-router.js';

const fileConfig = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'kimi-k31-chat';

const modelConfig = fileConfig.models[modelId];
if (!modelConfig) throw new Error(`No model "${modelId}" in config.json`);
if (modelConfig.capabilities.thinkingLevels.includes('none')) {
    throw new Error(`${modelId} declares a "none" level, but the provider rejects disabled thinking — the config is wrong`);
}

const router = new ModelRouter({
    models: { [modelId]: modelConfig },
    tasks: {},
    context: fileConfig.context,
    mediaProcessor: fileConfig.mediaProcessor,
    imageFetcher: fileConfig.imageFetcher
});

const message = { role: 'user', content: 'Say hi in three words.' };

async function run(label, thinkingFields) {
    const started = Date.now();
    try {
        const result = await router.routeChatCompletion({
            model: modelId,
            messages: [message],
            max_tokens: 512,
            stream: false,
            ...thinkingFields
        });
        const choice = result.choices?.[0];
        const reasoning = choice?.message?.reasoning_content ?? '';
        const text = choice?.message?.content ?? '';
        console.log(`PASS  ${label.padEnd(34)} ${String(Date.now() - started).padStart(5)}ms thinking_chars=${String(reasoning.length).padStart(4)} finish=${choice?.finish_reason} text="${text.replace(/\s+/g, ' ').slice(0, 40)}"`);
    } catch (error) {
        console.log(`FAIL  ${label.padEnd(34)} ${String(Date.now() - started).padStart(5)}ms ${String(error.message).replace(/\s+/g, ' ').slice(0, 160)}`);
        process.exitCode = 1;
    }
}

console.log(`model: ${modelId} (${modelConfig.adapterModel})  declared levels: ${modelConfig.capabilities.thinkingLevels.join(', ')}\n`);

console.log('-- what the client sends when thinking is switched off --');
await run('reasoning_effort=none + enable_thinking=false', { reasoning_effort: 'none', enable_thinking: false });
await run('enable_thinking=false only', { enable_thinking: false });

console.log('\n-- declared levels still work --');
await run('reasoning_effort=low', { reasoning_effort: 'low' });
await run('reasoning_effort=max', { reasoning_effort: 'max' });
await run('nothing sent (model default)', {});
