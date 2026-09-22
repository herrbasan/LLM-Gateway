// One-shot: bucket gemini requests + 429s per minute across gateway log files.
// Evidence tool: shows whether TPM saturation is request-count driven, not
// single-request context size. Usage: node scripts/gemini-tpm-audit.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'logs');
const files = readdirSync(dir).filter(f => f.endsWith('.log')).sort();

const minutes = new Map(); // 'YYYY-MM-DDTHH:MM' -> {req, t429, inputTokens, samples:Set}
let unparsed = 0;

for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    for (const line of lines) {
        if (!line.trim() || !line.includes('gemini')) continue;
        let e;
        try { e = JSON.parse(line); } catch { unparsed++; continue; }
        const ts = e.ts ?? e.timestamp ?? e.time;
        if (!ts) continue;
        const minute = String(ts).slice(0, 16); // 2026-09-21T15:16
        const m = minutes.get(minute) ?? { req: 0, t429: 0, inputTokens: 0, files: new Set() };
        m.files.add(f);
        const blob = line; // raw line already contains 'gemini'
        const is429 = blob.includes('429') || blob.includes('rate_limit') || blob.includes('Too Many Requests');
        // A request line vs an error line: count debug/request-type lines as requests
        const isReq = !is429 && (blob.includes('"type":"request"') || blob.includes('Stream start') || blob.includes('Chat request') || blob.includes('chatComplete') || blob.includes('streamComplete'));
        if (is429) m.t429++;
        else if (isReq) m.req++;
        // usage if present (any casing)
        const usageMatch = blob.match(/"(?:prompt_tokens|total_input_tokens|input_tokens)"\s*:\s*(\d+)/g);
        if (usageMatch) for (const u of usageMatch) {
            const n = Number(u.match(/(\d+)/)[1]);
            if (Number.isFinite(n) && n > 0 && n < 2000000) m.inputTokens += n;
        }
        minutes.set(minute, m);
    }
}

const rows = [...minutes.entries()]
    .filter(([, m]) => m.req > 0 || m.t429 > 0)
    .sort((a, b) => (b[1].req + b[1].t429 * 2) - (a[1].req + a[1].t429 * 2))
    .slice(0, 15);

console.log(`files scanned: ${files.length}, unparsed gemini lines: ${unparsed}`);
console.log('minute | requests | 429s | summed input tokens (where logged)');
for (const [min, m] of rows) {
    console.log(`${min} | ${m.req} | ${m.t429} | ${m.inputTokens}`);
}
if (!rows.length) console.log('no gemini request/429 lines found — check line format (keys sample):');
