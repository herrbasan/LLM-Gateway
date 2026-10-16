/**
 * End-to-end proof that the thinking a DeepSeek tool-call continuation requires is
 * supplied, so the session continues instead of dying on every resend.
 *
 * The three shapes that killed a session on 2026-10-16:
 *   1. a tool-call turn whose thinking the client did not echo and the cache does
 *      not have (the turn predated a restart, or came from another adapter);
 *   2. a trailing assistant turn carrying no thinking at all;
 *   3. a trailing assistant turn that does carry reasoning — which the old
 *      ENDS_ON_ANSWER refusal rejected even though the upstream accepts it.
 *
 * Goes through the REAL adapter to the configured endpoint, so the formatting, the
 * repairs and the egress all run. Run: node scripts/verify-prior-thinking-e2e.mjs
 */
import fs from 'node:fs';
import { createAnthropicAdapter } from '../src/adapters/anthropic.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'deepseek-flash-chat';
const modelConfig = config.models[modelId];

if (modelConfig?.capabilities?.priorReasoning === undefined) {
    throw new Error(`${modelId} does not declare capabilities.priorReasoning — nothing to verify`);
}

const TOOLS = [{
    type: 'function',
    function: {
        name: 'ping',
        description: 'Ping a host',
        parameters: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] }
    }
}];

const call = (id) => ({ id, type: 'function', function: { name: 'ping', arguments: '{"host":"a"}' } });

const CASES = [
    {
        name: 'tool-call turn, no client echo, id not in the cache',
        tools: true,
        messages: [
            { role: 'user', content: 'Ping host a.' },
            { role: 'assistant', content: '', tool_calls: [call(`call_probe_${Date.now()}`)] },
            { role: 'tool', tool_call_id: `call_probe_${Date.now()}`, content: 'pong' }
        ]
    },
    {
        name: 'trailing assistant turn with no thinking at all',
        tools: true,
        messages: [
            { role: 'user', content: 'Count to three.' },
            { role: 'assistant', content: 'One, two,' }
        ]
    },
    {
        name: 'trailing assistant turn WITH reasoning (the old refusal)',
        tools: true,
        messages: [
            { role: 'user', content: 'Say hi.' },
            { role: 'assistant', content: 'Hi.', reasoning_content: 'Greeting back.' }
        ]
    }
];

console.log(`model: ${modelId}  (${modelConfig.adapterModel} @ ${modelConfig.endpoint})`);
console.log(`priorReasoning: ${modelConfig.capabilities.priorReasoning}`);

const adapter = createAnthropicAdapter();
let failures = 0;

for (const testCase of CASES) {
    let outcome;
    try {
        const response = await adapter.chatComplete(modelConfig, {
            messages: testCase.messages,
            ...(testCase.tools ? { tools: TOOLS } : {}),
            maxTokens: 64,
            stream: false
        });
        outcome = `ACCEPTED — ${JSON.stringify(response).slice(0, 90)}`;
    } catch (error) {
        outcome = `FAILED — ${error.message.slice(0, 200)}`;
        failures++;
    }
    console.log(`\n${testCase.name}\n  ${outcome}`);
}

console.log(`\n${CASES.length - failures}/${CASES.length} shapes accepted.`);
console.log('Each of these was a 400 on every turn of a session before the repair:');
console.log('"The `content[].thinking` in the thinking mode must be passed back to the API".');
process.exit(failures === 0 ? 0 : 1);
