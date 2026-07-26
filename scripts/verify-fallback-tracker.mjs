// Verify FallbackTracker cooldown semantics (embeddings-only fallback).
// Exits 0 on pass.
import assert from 'node:assert';
import { FallbackTracker } from '../src/core/fallback-tracker.js';

const t = new FallbackTracker();
const TASK = 'embed';
const COOLDOWN = 50; // ms

// 1. Primary fails → shouldUseFallback true
t.recordFailure(TASK, 'local-embed', COOLDOWN, new Error('connection refused'));
assert.strictEqual(t.shouldUseFallback(TASK), true, 'after failure, should use fallback');

// 2. Fallback serves successfully → state must NOT clear (cooldown keeps running)
t.recordSuccess(TASK, /* servedByFallback */ true);
assert.strictEqual(t.shouldUseFallback(TASK), true, 'fallback success must NOT clear state');

// 3. After cooldown expiry, primary is retried (state cleared on access)
await new Promise(r => setTimeout(r, COOLDOWN + 20));
assert.strictEqual(t.shouldUseFallback(TASK), false, 'after cooldown, primary retried');

// 4. Primary succeeds → clears any state cleanly
t.recordFailure(TASK, 'local-embed', COOLDOWN, new Error('down again'));
assert.strictEqual(t.shouldUseFallback(TASK), true, 're-entered fallback on new failure');
t.recordSuccess(TASK, /* servedByFallback */ false);
assert.strictEqual(t.shouldUseFallback(TASK), false, 'primary success clears state');

console.log('FALLBACK_TRACKER_PASS');
process.exit(0);
