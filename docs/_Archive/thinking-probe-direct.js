/**
 * Direct Upstream Thinking Probe
 * Hits upstream APIs directly with their native request formats.
 * Bypasses gateway normalization to discover what each API actually needs.
 */

import fs from 'fs';

const CONFIG = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
const TEST_PROMPT = 'What is 2+2? Think step by step.';

async function probeOpenAICompatible(name, cfg, shapes) {
    const results = [];
    const endpoint = cfg.endpoint.replace(/\/$/, '') + '/chat/completions';

    for (const shape of shapes) {
        const payload = {
            model: cfg.adapterModel,
            messages: [{ role: 'user', content: TEST_PROMPT }],
            stream: false,
            max_tokens: 256,
            ...shape.params
        };

        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        if (cfg.headers) Object.assign(headers, cfg.headers);

        try {
            const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
            const data = await res.json();
            const msg = data.choices?.[0]?.message || {};
            results.push({
                shape: shape.name,
                status: data.error ? (data.error.code || res.status) : res.status,
                hasReasoning: !!msg.reasoning_content,
                reasoningLen: msg.reasoning_content?.length || 0,
                contentLen: msg.content?.length || 0,
                error: data.error?.message || null
            });
        } catch (e) {
            results.push({ shape: shape.name, status: 'ERR', hasReasoning: false, reasoningLen: 0, contentLen: 0, error: e.message });
        }
        await new Promise(r => setTimeout(r, 300));
    }
    return results;
}

async function probeAnthropic(name, cfg) {
    const results = [];
    const endpoint = cfg.endpoint.replace(/\/$/, '') + '/messages';
    const shapes = [
        { name: 'none', thinking: undefined },
        { name: 'thinking_enabled', thinking: { type: 'enabled', budget_tokens: 16000 } },
        { name: 'thinking_disabled', thinking: { type: 'disabled' } },
    ];

    for (const shape of shapes) {
        const payload = {
            model: cfg.adapterModel,
            max_tokens: 256,
            messages: [{ role: 'user', content: TEST_PROMPT }],
            ...(shape.thinking ? { thinking: shape.thinking } : {})
        };

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': cfg.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            const content = data.content || [];
            const thinkingBlocks = content.filter(b => b.type === 'thinking');
            const textBlocks = content.filter(b => b.type === 'text');
            results.push({
                shape: shape.name,
                status: data.error ? (data.error.type || res.status) : res.status,
                hasReasoning: thinkingBlocks.length > 0,
                reasoningLen: thinkingBlocks.map(b => b.thinking?.length || 0).reduce((a, b) => a + b, 0),
                contentLen: textBlocks.map(b => b.text?.length || 0).reduce((a, b) => a + b, 0),
                error: data.error?.message || null
            });
        } catch (e) {
            results.push({ shape: shape.name, status: 'ERR', hasReasoning: false, reasoningLen: 0, contentLen: 0, error: e.message });
        }
        await new Promise(r => setTimeout(r, 300));
    }
    return results;
}

async function probeGemini(name, cfg) {
    const results = [];
    const endpoint = cfg.endpoint.replace(/\/$/, '') + `/models/${cfg.adapterModel}:generateContent?key=${cfg.apiKey}`;
    const shapes = [
        { name: 'none', generationConfig: {} },
        { name: 'thinkingConfig_high', generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } } },
        { name: 'thinkingConfig_low', generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 0 } } },
    ];

    for (const shape of shapes) {
        const payload = {
            contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
            generationConfig: { maxOutputTokens: 256, ...shape.generationConfig }
        };

        try {
            const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const data = await res.json();
            const parts = data.candidates?.[0]?.content?.parts || [];
            const thoughts = parts.filter(p => p.thought);
            const text = parts.filter(p => p.text);
            results.push({
                shape: shape.name,
                status: data.error ? (data.error.code || res.status) : res.status,
                hasReasoning: thoughts.length > 0,
                reasoningLen: thoughts.map(t => JSON.stringify(t).length).reduce((a, b) => a + b, 0),
                contentLen: text.map(t => t.text?.length || 0).reduce((a, b) => a + b, 0),
                error: data.error?.message || null
            });
        } catch (e) {
            results.push({ shape: shape.name, status: 'ERR', hasReasoning: false, reasoningLen: 0, contentLen: 0, error: e.message });
        }
        await new Promise(r => setTimeout(r, 300));
    }
    return results;
}

async function main() {
    const report = {};

    // OpenAI-compatible models (native OpenAI format)
    const openaiShapes = [
        { name: 'none', params: {} },
        { name: 'enable_thinking_true', params: { enable_thinking: true } },
        { name: 'enable_thinking_false', params: { enable_thinking: false } },
        { name: 'chat_template_kwargs_true', params: { chat_template_kwargs: { enable_thinking: true } } },
        { name: 'chat_template_kwargs_false', params: { chat_template_kwargs: { enable_thinking: false } } },
        { name: 'reasoning_effort_low', params: { reasoning_effort: 'low' } },
        { name: 'reasoning_effort_high', params: { reasoning_effort: 'high' } },
    ];

    for (const [name, cfg] of Object.entries(CONFIG.models)) {
        if (cfg.disabled) continue;

        let results;
        if (cfg.adapter === 'openai' || cfg.adapter === 'lmstudio' || cfg.adapter === 'llamacpp') {
            console.log(`[TEST] ${name} (openai-format) ...`);
            results = await probeOpenAICompatible(name, cfg, openaiShapes);
        } else if (cfg.adapter === 'anthropic') {
            console.log(`[TEST] ${name} (anthropic-format) ...`);
            results = await probeAnthropic(name, cfg);
        } else if (cfg.adapter === 'gemini') {
            console.log(`[TEST] ${name} (gemini-format) ...`);
            results = await probeGemini(name, cfg);
        } else {
            continue;
        }

        report[name] = results;
        for (const r of results) {
            const status = r.error ? `ERROR(${r.status})` : `OK`;
            const reasoning = r.hasReasoning ? `reasoning=${r.reasoningLen}` : 'no-reasoning';
            console.log(`  ${r.shape.padEnd(35)} → ${status} | ${reasoning} | content=${r.contentLen}`);
        }
    }

    fs.writeFileSync('thinking-probe-direct.json', JSON.stringify(report, null, 2));
    console.log('\nReport written to thinking-probe-direct.json');
}

main().catch(err => { console.error('Probe failed:', err); process.exit(1); });
