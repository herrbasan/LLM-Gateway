/**
 * Thinking Control Probe v2
 * Tests through the gateway's REST API so adapters handle translation.
 */

import fs from 'fs';

const GATEWAY_URL = 'http://localhost:3400';
const TEST_PROMPT = 'What is 2+2? Think step by step.';
const MAX_TOKENS = 256;

// Parameter shapes to test
const SHAPES = [
    { name: 'none', params: {} },
    { name: 'enable_thinking_true', params: { enable_thinking: true } },
    { name: 'enable_thinking_false', params: { enable_thinking: false } },
    { name: 'chat_template_kwargs_true', params: { extra_body: { chat_template_kwargs: { enable_thinking: true } } } },
    { name: 'chat_template_kwargs_false', params: { extra_body: { chat_template_kwargs: { enable_thinking: false } } } },
    { name: 'reasoning_effort_low', params: { reasoning_effort: 'low' } },
    { name: 'reasoning_effort_high', params: { reasoning_effort: 'high' } },
];

async function probeModel(modelId) {
    const results = [];

    for (const shape of SHAPES) {
        try {
            const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelId,
                    messages: [{ role: 'user', content: TEST_PROMPT }],
                    max_tokens: MAX_TOKENS,
                    ...shape.params
                })
            });

            const data = await res.json();

            if (data.error) {
                results.push({
                    shape: shape.name,
                    status: data.error.code || res.status,
                    hasReasoning: false,
                    reasoningLen: 0,
                    contentLen: 0,
                    finishReason: null,
                    error: data.error.message
                });
                continue;
            }

            const msg = data.choices?.[0]?.message || {};
            const hasReasoning = !!msg.reasoning_content;
            const reasoningLen = msg.reasoning_content?.length || 0;
            const contentLen = msg.content?.length || 0;

            results.push({
                shape: shape.name,
                status: res.status,
                hasReasoning,
                reasoningLen,
                contentLen,
                finishReason: data.choices?.[0]?.finish_reason,
                error: null
            });
        } catch (err) {
            results.push({
                shape: shape.name,
                status: 'FETCH_ERROR',
                hasReasoning: false,
                reasoningLen: 0,
                contentLen: 0,
                finishReason: null,
                error: err.message
            });
        }

        // Small delay between requests
        await new Promise(r => setTimeout(r, 200));
    }

    return results;
}

async function main() {
    const modelsToTest = [
        'kimi-chat',
        'kimi-k2.5-chat',
        'al-qwen-chat',
        'al-qwen-max-chat',
        'deepseek-chat',
        'deepseek-flash-chat',
        'glm5-chat',
        'minimax-chat',
        'grok-chat',
        'gpt-chat',
        'gemini-flash-chat',
        'badkid-llama-chat',
    ];

    const report = {};

    for (const modelId of modelsToTest) {
        console.log(`[TEST] ${modelId} ...`);
        try {
            const results = await probeModel(modelId);
            report[modelId] = results;

            for (const r of results) {
                const status = r.error ? `ERROR(${r.status})` : `OK`;
                const reasoning = r.hasReasoning ? `reasoning=${r.reasoningLen}` : 'no-reasoning';
                console.log(`  ${r.shape.padEnd(35)} → ${status} | ${reasoning} | content=${r.contentLen}`);
            }
        } catch (err) {
            console.log(`  FAILED: ${err.message}`);
            report[modelId] = [{ shape: 'all', error: err.message }];
        }
    }

    fs.writeFileSync('thinking-probe-report.json', JSON.stringify(report, null, 2));
    console.log('\nReport written to thinking-probe-report.json');
}

main().catch(err => {
    console.error('Probe failed:', err);
    process.exit(1);
});
