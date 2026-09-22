// One-shot: summarize nPM's llm_gateway ERROR log dump — group by error signature, count, time range.
// Usage: node scripts/analyze-npm-errors.mjs <path-to-json>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/analyze-npm-errors.mjs <json-file>'); process.exit(1); }

const raw = JSON.parse(readFileSync(file, 'utf8'));
// nPM may wrap the array ({logs:[...]}) or return it bare — handle both, external boundary.
const entries = Array.isArray(raw) ? raw : (raw.logs ?? raw.entries ?? raw.lines ?? null);
if (!Array.isArray(entries)) {
  console.error('unrecognized payload shape; top-level keys:', Object.keys(raw));
  process.exit(1);
}

console.log(`total entries: ${entries.length}`);

// Find the per-entry text field defensively (external data).
const textOf = (e) => {
  if (typeof e === 'string') return e;
  for (const k of ['message', 'error', 'text', 'line', 'msg']) {
    if (typeof e[k] === 'string' && e[k].length) return e[k];
  }
  return JSON.stringify(e).slice(0, 200);
};
const tsOf = (e) => (typeof e === 'object' && (e.timestamp ?? e.ts ?? e.time)) ?? '?';

const groups = new Map(); // key -> {count, first, last, sample}
for (const e of entries) {
  const text = textOf(e);
  // Normalize: collapse numbers/ids so identical failures group together.
  const sig = text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
  const g = groups.get(sig) ?? { count: 0, first: tsOf(e), last: tsOf(e), sample: text.slice(0, 400) };
  g.count++;
  g.last = tsOf(e);
  groups.set(sig, g);
}

const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [sig, g] of sorted) {
  console.log(`\n### ${g.count}x  [${g.first} .. ${g.last}]`);
  console.log(`sample: ${g.sample}`);
}
