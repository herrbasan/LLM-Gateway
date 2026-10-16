/**
 * End-to-end proof that a poisoned history no longer kills a session.
 *
 * The 2026-09-19 incident: a VS Code turn recorded the same tool call twice under
 * one id. The gateway forwarded it verbatim, the upstream rejected the request on
 * every retry, and the session was dead until the client's own history changed.
 *
 * This sends that exact shape through the REAL adapter to the configured upstream,
 * so both the formatting path and the invariant pass are exercised — and then sends
 * the same shape with the pass bypassed, to prove the upstream genuinely rejects it.
 * Without that second half the test could pass for the wrong reason.
 *
 * Run: node scripts/verify-history-repair-e2e.mjs [modelId]
 */
import fs from 'node:fs';
import { createAnthropicAdapter } from '../src/adapters/anthropic.js';
import { request as httpRequest } from '../src/utils/http.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'deepseek-flash-chat';
const modelConfig = config.models[modelId];

if (modelConfig?.adapter !== 'anthropic') {
    throw new Error(`${modelId} is not an anthropic-adapter model (adapter=${modelConfig?.adapter})`);
}

const TOOLS = [{
    type: 'function',
    function: {
        name: 'ping',
        description: 'Ping a host',
        parameters: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] }
    }
}];

// The poison, in the shape a client sends the gateway.
const poisoned = [
    { role: 'user', content: 'Ping host a.' },
    {
        role: 'assistant',
        content: 'Checking.',
        reasoning_content: 'The client echoes the model\'s reasoning back, and DeepSeek refuses a tool-call continuation without it.',
        tool_calls: [
            { type: 'function', id: 'call_dup', function: { name: 'ping', arguments: '{"host":"a"}' } },
            { type: 'function', id: 'call_dup', function: { name: 'ping', arguments: '{"host":"a"}' } }
        ]
    },
    { role: 'tool', tool_call_id: 'call_dup', content: 'pong' },
    { role: 'tool', tool_call_id: 'call_ghost', content: 'pong' },
    { role: 'user', content: '' }
];

// The 2026-10-16 shape: the same upstream slip, but this time the client executed
// BOTH calls it was handed and sent a result for each. Dropping the repeat then left
// the second result with no call to answer — "each tool_use must have a single
// result", on every resend, until the session died.
const poisonedTwice = [
    { role: 'user', content: 'Ping host a and host b.' },
    {
        role: 'assistant',
        content: 'Checking both.',
        reasoning_content: 'The client echoes the model\'s reasoning back, and DeepSeek refuses a tool-call continuation without it.',
        tool_calls: [
            { type: 'function', id: 'call_twice', function: { name: 'ping', arguments: '{"host":"a"}' } },
            { type: 'function', id: 'call_twice', function: { name: 'ping', arguments: '{"host":"b"}' } }
        ]
    },
    { role: 'tool', tool_call_id: 'call_twice', content: 'pong a' },
    { role: 'tool', tool_call_id: 'call_twice', content: 'pong b' }
];

// The same first turn as raw Anthropic blocks — what the adapter would emit if the
// pass did nothing, sent straight upstream to show it is fatal.
const rawDuplicateTurn = [
    { role: 'user', content: [{ type: 'text', text: 'Ping host a.' }] },
    {
        role: 'assistant',
        content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'call_dup', name: 'ping', input: { host: 'a' } },
            { type: 'tool_use', id: 'call_dup', name: 'ping', input: { host: 'a' } }
        ]
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_dup', content: 'pong' }] }
];

console.log(`model: ${modelId}  (${modelConfig.adapterModel} @ ${modelConfig.endpoint})`);
const adapter = createAnthropicAdapter();

console.log('\n1. endpoint reachable?');
try {
    await adapter.chatComplete(modelConfig, { messages: [{ role: 'user', content: 'Say hi.' }], maxTokens: 16, stream: false });
    console.log('   ok');
} catch (error) {
    console.log(`   FAILED: ${error.message.slice(0, 200)}`);
    process.exit(1);
}

console.log('\n2. poisoned history through the adapter (pass active) — expect success');
try {
    const response = await adapter.chatComplete(modelConfig, {
        messages: poisoned,
        tools: TOOLS,
        maxTokens: 32,
        stream: false
    });
    console.log(`   ACCEPTED: ${JSON.stringify(response).slice(0, 180)}`);
} catch (error) {
    // A rejection here names whichever rule the upstream checks next, so the message
    // is the interesting part: if it is no longer about tool_use ids, the pass did
    // its job and something else is the remaining blocker.
    console.log(`   REJECTED: ${error.message.slice(0, 240)}`);
}

console.log('\n3. same duplicate-id turn sent raw (pass bypassed) — expect rejection');
{
    const response = await fetch(`${modelConfig.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': modelConfig.apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: modelConfig.adapterModel, max_tokens: 32, messages: rawDuplicateTurn })
    });
    const body = await response.text();
    if (response.ok) {
        console.log('   UNEXPECTED 200 — the upstream accepted it, so this is not the poison');
        process.exit(1);
    }
    console.log(`   REJECTED as expected (${response.status}): ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
}

console.log('\n4. the 2026-10-16 shape (both calls answered) — expect success');
try {
    const response = await adapter.chatComplete(modelConfig, {
        messages: poisonedTwice,
        tools: TOOLS,
        maxTokens: 32,
        stream: false
    });
    console.log(`   ACCEPTED: ${JSON.stringify(response).slice(0, 180)}`);
} catch (error) {
    console.log(`   REJECTED: ${error.message.slice(0, 240)}`);
}

console.log('\nRead the pair: step 3 shows the exact rejection the incidents produced');
console.log('(a `tool_use` id must have exactly one result). Steps 2 and 4 show that');
console.log('rejection gone when the pass runs — if one names a DIFFERENT rule, that rule is');
console.log('the next blocker for this upstream, not a failure of the pass.');
