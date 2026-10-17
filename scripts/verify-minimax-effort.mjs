/**
 * Verify that effort reaches MiniMax M3.1 Flash through the adapter.
 *
 * The config declares thinkingLevels + thinkingEffort, so the router stops dropping the
 * value and the adapter maps it to output_config.effort. Measured on the bare endpoint
 * 2026-10-17: low → 0 thinking chars, medium → 62, high → 76, max → 115 — the lever
 * works, and only "off" is refused ("requires adaptive thinking").
 *
 * Run: node scripts/verify-minimax-effort.mjs
 */
import fs from 'node:fs';
import { createAnthropicAdapter } from '../src/adapters/anthropic.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'minimax-m31-flash-chat';
const modelConfig = config.models[modelId];
const caps = modelConfig.capabilities;

if (!caps.thinkingEffort || !Array.isArray(caps.thinkingLevels)) {
    throw new Error(`${modelId} does not declare thinkingEffort + thinkingLevels — nothing to verify`);
}

console.log(`model: ${modelId}  levels=${caps.thinkingLevels.join(',')}  thinkingEffort=${caps.thinkingEffort}\n`);

const adapter = createAnthropicAdapter();

for (const effort of caps.thinkingLevels) {
    const response = await adapter.chatComplete(modelConfig, {
        messages: [{ role: 'user', content: 'Say hi in three words.' }],
        reasoning_effort: effort,
        maxTokens: 64,
        stream: false
    });
    const reasoning = response.choices?.[0]?.message?.reasoning_content ?? '';
    console.log(`${effort.padEnd(8)} thinking chars: ${String(reasoning.length).padStart(4)}`);
}

// 'off' is impossible on this model; the adapter must not send thinking.type=disabled
// (the provider rejects it with "requires adaptive thinking"). It omits the field.
const offResponse = await adapter.chatComplete(modelConfig, {
    messages: [{ role: 'user', content: 'Say hi in three words.' }],
    reasoning_effort: 'none',
    maxTokens: 64,
    stream: false
});
console.log(`\nnone sent → accepted (no 400); thinking chars: ${(offResponse.choices?.[0]?.message?.reasoning_content ?? '').length}`);
