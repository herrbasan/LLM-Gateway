/**
 * Does the output-budget retry actually save a request against the live upstream?
 *
 * Forces the same rejection the 2026-09-19 incident produced, without sending a
 * 664K-token prompt: asking for a max_tokens larger than the whole window makes
 * prompt + budget overshoot regardless of how short the prompt is. The upstream
 * reports both numbers, the retry recomputes the budget, and the request goes
 * through — which is the whole claim.
 *
 * Run: node scripts/verify-budget-retry-e2e.mjs [modelId]
 */
import fs from 'node:fs';
import { createAnthropicAdapter } from '../src/adapters/anthropic.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'deepseek-flash-chat';
const modelConfig = config.models[modelId];

if (modelConfig?.adapter !== 'anthropic') {
    throw new Error(`${modelId} is not an anthropic-adapter model`);
}

const windowTokens = modelConfig.capabilities?.contextWindow ?? 0;
const absurdBudget = windowTokens + 50;   // guarantees prompt + budget > window

console.log(`model: ${modelId}  window: ${windowTokens}  requesting max_tokens: ${absurdBudget}`);
console.log('expectation: upstream rejects once, retry shrinks the budget, request succeeds\n');

const adapter = createAnthropicAdapter();

try {
    const response = await adapter.chatComplete(modelConfig, {
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: absurdBudget,
        stream: false
    });
    console.log('RESULT: accepted after the retry — the overshoot no longer kills the request');
    console.log(`        response: ${JSON.stringify(response).slice(0, 160)}`);
} catch (error) {
    console.log(`RESULT: still rejected — ${String(error.message).slice(0, 240)}`);
    process.exit(1);
}
