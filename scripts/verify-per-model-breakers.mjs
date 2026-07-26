// Verify per-model breaker isolation: tripping model A's breaker does NOT
// fast-fail model B on the same adapter. Exits 0 on pass.
import assert from 'node:assert';
import { createAdapters } from '../src/core/adapters.js';

const adapters = createAdapters();
const openai = adapters.get('openai');

const deadA = {
    type: 'chat', adapter: 'openai',
    endpoint: 'http://localhost:55555', adapterModel: 'model-a',
    capabilities: { contextWindow: 8192 }
};
const deadB = {
    type: 'chat', adapter: 'openai',
    endpoint: 'http://localhost:55556', adapterModel: 'model-b',
    capabilities: { contextWindow: 8192 }
};

// Trip model A's breaker (threshold 3)
for (let i = 0; i < 3; i++) {
    try { await openai.chatComplete(deadA, { messages: [], __modelId: 'model-a' }); } catch {}
}

// 4th request to A should fast-fail with 503 (breaker open)
let aStatus = null;
try { await openai.chatComplete(deadA, { messages: [], __modelId: 'model-a' }); }
catch (err) { aStatus = err.status; }

// Request to B should NOT fast-fail — it attempts the network call and fails
// with a FETCH_ERROR (connection refused), not a 503 circuit-open.
let bStatus = null, bCode = null;
try { await openai.chatComplete(deadB, { messages: [], __modelId: 'model-b' }); }
catch (err) { bStatus = err.status; bCode = err.code; }

console.log('A 4th request status (expect 503):', aStatus);
console.log('B request code (expect FETCH_ERROR, not circuit):', bCode, '| status:', bStatus);

assert.strictEqual(aStatus, 503, 'model A breaker should be open (503)');
assert.notStrictEqual(bStatus, 503, 'model B must NOT be fast-failed by A\'s breaker');
assert.strictEqual(bCode, 'FETCH_ERROR', 'model B should attempt the call and fail with FETCH_ERROR');

console.log('PER_MODEL_ISOLATION_PASS');
process.exit(0);
