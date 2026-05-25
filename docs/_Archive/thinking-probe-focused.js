/**
 * Focused Direct Upstream Thinking Probe
 * Tests one model at a time to avoid hangs.
 */

import fs from 'fs';

const CONFIG = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
const TEST_PROMPT = 'What is 2+2? Think step by step.';

async function testOpenAI(name, cfg) {
    const endpoint = cfg.endpoint.replace(/\/$/, '') + '/chat/completions';
    const shapes = [
        { name: 'none', params: {} },
        { name: 'enable_thinking_false', params: { enable_thinking: false } },
        { name: 'chat_template_kwargs_false', params: { chat_template_kwargs: { enable_thinking: false } } },
    ];

    console.log(`\n[${name}] ${cfg.adapterModel} @ ${endpoint}`);
    for (const shape of shapes) {
        const payload = {
            model: cfg.adapterModel,
            messages: [{ role: 'user', content: TEST_PROMPT }],
            stream: false,
            max_tokens: 256,
            ...shape.params
        };
        const headers = {
            'Content-Type': 'application/json',
            ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}),
            ...(cfg.headers || {})
        };

        try {
            const ctrl = new AbortController();
            const timeout = setTimeout(() => ctrl.abort(), 15000);
            const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
            clearTimeout(timeout);
            const data = await res.json();
            const msg = data.choices?.[0]?.message || {};
            const status = data.error ? `ERROR(${data.error.code || res.status})` : 'OK';
            const reasoning = msg.reasoning_content ? `reasoning=${msg.reasoning_content.length}` : 'no-reasoning';
            console.log(`  ${shape.name.padEnd(30)} → ${status} | ${reasoning} | content=${msg.content?.length || 0}`);
        } catch (e) {
            console.log(`  ${shape.name.padEnd(30)} → TIMEOUT/ERR | ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

async function testAnthropic(name, cfg) {
    const endpoint = cfg.endpoint.replace(/\/$/, '') + '/messages';
    const shapes = [
        { name: 'none', thinking: undefined },
        { name: 'thinking_enabled', thinking: { type: 'enabled', budget_tokens: 16000 } },
        { name: 'thinking_disabled', thinking: { type: 'disabled' } },
    ];

    console.log(`\n[${name}] ${cfg.adapterModel} @ ${endpoint}`);
    for (const shape of shapes) {
        const payload = {
            model: cfg.adapterModel,
            max_tokens: 256,
            messages: [{ role: 'user', content: TEST_PROMPT }],
            ...(shape.thinking ? { thinking: shape.thinking } : {})
        };
        try {
            const ctrl = new AbortController();
            const timeout = setTimeout(() => ctrl.abort(), 15000);
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': cfg.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify(payload),
                signal: ctrl.signal
            });
            clearTimeout(timeout);
            const data = await res.json();
            const content = data.content || [];
            const thinking = content.filter(b => b.type === 'thinking');
            const text = content.filter(b => b.type === 'text');
            const status = data.error ? `ERROR(${data.error.type || res.status})` : 'OK';
            const reasoning = thinking.length > 0 ? `reasoning=${thinking.map(b => b.thinking?.length || 0).reduce((a,b)=>a+b,0)}` : 'no-reasoning';
            console.log(`  ${shape.name.padEnd(30)} → ${status} | ${reasoning} | content=${text.map(b => b.text?.length || 0).reduce((a,b)=>a+b,0)}`);
        } catch (e) {
            console.log(`  ${shape.name.padEnd(30)} → TIMEOUT/ERR | ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

async function main() {
    const target = process.argv[2];
    if (!target) {
        console.log('Usage: node tests/thinking-probe-focused.js <model-id>');
        console.log('Examples: al-qwen-chat, deepseek-chat, minimax-chat, gpt-chat, gemini-flash-chat');
        process.exit(1);
    }

    const cfg = CONFIG.models[target];
    if (!cfg) { console.log(`Model ${target} not found`); process.exit(1); }

    if (cfg.adapter === 'openai' || cfg.adapter === 'lmstudio' || cfg.adapter === 'llamacpp') {
        await testOpenAI(target, cfg);
    } else if (cfg.adapter === 'anthropic') {
        await testAnthropic(target, cfg);
    } else {
        console.log(`Adapter ${cfg.adapter} not yet supported in this probe`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
