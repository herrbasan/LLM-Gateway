// Verify P0 batch-1 fixes. Exits 0 on all-pass, 1 on any failure.
import assert from 'node:assert';
import { request as httpRequest } from '../src/utils/http.js';
import { createAnthropicAdapter } from '../src/adapters/anthropic.js';

let failures = 0;
const check = (name, fn) => {
    try { fn(); console.log(`PASS  ${name}`); }
    catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
};

// --- Fix 1: http.js sanitizeUrl scrubs credentials from error messages ---
// Force a network error against an unroutable address with a ?key= param.
{
    let errMsg = '';
    try {
        await httpRequest('http://localhost:55555/models/x?key=SECRET_API_KEY_123', {
            method: 'POST', body: '{}',
            retry: { maxRetries: 0 }
        });
    } catch (err) { errMsg = err.message; }
    check('http.js redacts ?key= from error message', () => {
        assert.ok(errMsg.length > 0, 'expected a fetch error');
        assert.ok(!errMsg.includes('SECRET_API_KEY_123'), `key leaked: ${errMsg}`);
        assert.ok(errMsg.includes('REDACTED'), `no redaction marker: ${errMsg}`);
    });
}

// --- Fix 2: parseArguments no longer fabricates {} (tested via formatMessages path) ---
// parseArguments is internal; exercise it through a chatComplete with a malformed
// tool-call in history, using a dead endpoint so we fail fast after payload build.
{
    const adapter = createAnthropicAdapter();
    let errMsg = '';
    try {
        await adapter.chatComplete(
            { endpoint: 'http://localhost:55555', apiKey: 'k', adapterModel: 'm', capabilities: { contextWindow: 1000 } },
            { messages: [
                { role: 'assistant', content: 'x', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{invalid json' } }] },
                { role: 'user', content: 'go' }
            ], maxTokens: 100 }
        );
    } catch (err) { errMsg = err.message; }
    check('anthropic parseArguments throws on malformed tool-call JSON', () => {
        assert.ok(errMsg.includes('Malformed tool-call arguments'), `unexpected: ${errMsg}`);
    });
}

// --- Fix 3: buildThinkingConfig guards NaN budget ---
{
    const adapter = createAnthropicAdapter();
    let errMsg = '';
    try {
        // thinking enabled, no maxTokens, no maxOutputTokens capability → must throw before NaN
        await adapter.chatComplete(
            { endpoint: 'http://localhost:55555', apiKey: 'k', adapterModel: 'm', capabilities: { contextWindow: 1000 } },
            { messages: [{ role: 'user', content: 'hi' }], enable_thinking: true }
        );
    } catch (err) { errMsg = err.message; }
    check('buildThinkingConfig throws on missing maxTokens (no NaN budget)', () => {
        assert.ok(errMsg.includes('thinking budget requires a finite maxTokens'), `unexpected: ${errMsg}`);
    });
}

console.log(failures === 0 ? 'BATCH1_VERIFY_PASS' : `BATCH1_VERIFY_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
