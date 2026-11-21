// Probes the Gemini 4 models (hydrogen/carbon/argon) on the Interactions API.
// Verifies the model answers, whether thinking_level "xhigh" is accepted, and
// what comes back for usage/status. Reads the API key from config.json so no
// secret ever lands in this file.
//
//   node scripts/probe-gemini4.mjs [model ...]
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const apiKey = config.models['gemini-argon-chat'].apiKey;
const endpoint = config.models['gemini-argon-chat'].endpoint;

const models = process.argv.slice(2);
const targets = models.length > 0
    ? models
    : ['gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon'];

const levels = {
    'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'],
    'gemini-4-neon': ['low', 'medium', 'high', 'xhigh']
};

for (const model of targets) {
    for (const level of levels[model] ?? ['medium']) {
        const body = {
            model,
            store: false,
            input: [{ type: 'user_input', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
            generation_config: { thinking_level: level, max_output_tokens: 2048 }
        };
        const started = Date.now();
        const res = await fetch(`${endpoint}/interactions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body)
        });
        const text = await res.text();
        let summary;
        try {
            const json = JSON.parse(text);
            const out = (json.steps ?? [])
                .filter(s => s.type === 'model_output')
                .flatMap(s => s.content ?? [])
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('');
            summary = {
                status: json.status,
                finish: json.finish_reason ?? json.stop_reason ?? undefined,
                usage: json.usage ?? undefined,
                thinkTok: json.usage?.total_thought_tokens ?? json.usage?.thought_tokens ?? undefined,
                out: out.slice(0, 80),
                error: json.error?.message
            };
        } catch {
            summary = { raw: text.slice(0, 300) };
        }
        console.log(`${model} [${level}] HTTP ${res.status} ${Date.now() - started}ms`, JSON.stringify(summary));
    }
}
