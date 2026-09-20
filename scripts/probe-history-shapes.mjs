/**
 * Probe: which malformed-history shapes does each Anthropic-protocol upstream
 * accept?
 *
 * The gateway is stateless, so a client resends its whole history every turn. If
 * the upstream rejects a shape, the request fails every time and the session is
 * dead until the client's history changes. This asks the upstream directly which
 * shapes are fatal, so a repair pass can be built against facts instead of
 * assumptions.
 *
 * Sends raw Anthropic-protocol requests (the same shape src/adapters/anthropic.js
 * builds) straight to each configured endpoint. No gateway, no restart.
 *
 * Run: node scripts/probe-history-shapes.mjs [modelId ...]
 */
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

const DEFAULT_MODELS = ['deepseek-flash-chat', 'kimi-k3-chat'];
const modelIds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_MODELS;

const TOOLS = [{
    name: 'ping',
    description: 'Ping a host',
    input_schema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] }
}];

const text = (t) => ({ type: 'text', text: t });
const call = (id, host = 'a') => ({ type: 'tool_use', id, name: 'ping', input: { host } });
const result = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'pong' });

// Each case: a request body's `messages`. Tools are attached per case.
const CASES = [
    {
        name: 'baseline valid turn',
        messages: [{ role: 'user', content: [text('Say hi.')] }]
    },
    {
        name: 'consecutive user messages',
        messages: [
            { role: 'user', content: [text('Say hi.')] },
            { role: 'user', content: [text('Say hi again.')] }
        ]
    },
    {
        name: 'consecutive assistant messages',
        messages: [
            { role: 'user', content: [text('Say hi.')] },
            { role: 'assistant', content: [text('Hi.')] },
            { role: 'assistant', content: [text('Still here.')] }
        ]
    },
    {
        name: 'empty user content array',
        messages: [
            { role: 'user', content: [text('Say hi.')] },
            { role: 'assistant', content: [text('Hi.')] },
            { role: 'user', content: [] }
        ]
    },
    {
        name: 'empty assistant content array',
        messages: [
            { role: 'user', content: [text('Say hi.')] },
            { role: 'assistant', content: [] }
        ]
    },
    {
        name: 'two identical tool_use with ONE shared id',
        tools: true,
        messages: [
            { role: 'user', content: [text('Ping two hosts.')] },
            { role: 'assistant', content: [call('call_dup', 'a'), call('call_dup', 'a')] },
            { role: 'user', content: [result('call_dup')] }
        ]
    },
    {
        name: 'distinct tool_use ids, one result each (control)',
        tools: true,
        messages: [
            { role: 'user', content: [text('Ping two hosts.')] },
            { role: 'assistant', content: [call('call_1', 'a'), call('call_2', 'b')] },
            { role: 'user', content: [result('call_1'), result('call_2')] }
        ]
    },
    {
        name: 'tool_result for an unknown id (orphan result)',
        tools: true,
        messages: [
            { role: 'user', content: [text('Ping a host.')] },
            { role: 'assistant', content: [call('call_known')] },
            { role: 'user', content: [result('call_ghost')] }
        ]
    },
    {
        name: 'tool_use with no result, followed by plain text',
        tools: true,
        messages: [
            { role: 'user', content: [text('Ping a host.')] },
            { role: 'assistant', content: [call('call_1')] },
            { role: 'user', content: [text('Never mind.')] }
        ]
    },
    {
        name: 'tool_use with no result, as the LAST message',
        tools: true,
        messages: [
            { role: 'user', content: [text('Ping a host.')] },
            { role: 'assistant', content: [call('call_1')] }
        ]
    },
    {
        name: 'empty text block',
        messages: [
            { role: 'user', content: [text('Say hi.')] },
            { role: 'assistant', content: [text('Hi.')] },
            { role: 'user', content: [text('')] }
        ]
    },
    {
        name: 'history STARTS with an assistant message',
        messages: [
            { role: 'assistant', content: [text('Hi.')] },
            { role: 'user', content: [text('Say hi.')] }
        ]
    },
    {
        name: 'tool_result as the FIRST message (no call before it)',
        tools: true,
        messages: [
            { role: 'user', content: [result('call_orphan')] },
            { role: 'assistant', content: [text('Ok.')] }
        ]
    }
];

async function probe(modelId, testCase) {
    const model = config.models[modelId];
    if (!model) throw new Error(`Unknown model in config.json: ${modelId}`);

    const body = {
        model: model.adapterModel,
        max_tokens: 32,
        messages: testCase.messages,
        ...(testCase.tools ? { tools: TOOLS } : {})
    };
    if (model.reasoning_effort) body.output_config = { effort: model.reasoning_effort };

    const response = await fetch(`${model.endpoint}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
    });

    const raw = await response.text();
    let detail = raw.slice(0, 240).replace(/\s+/g, ' ');
    try {
        const parsed = JSON.parse(raw);
        if (parsed.error) detail = `${parsed.error.type ?? ''} ${parsed.error.message ?? ''}`.trim();
        else detail = `ok (stop_reason=${parsed.stop_reason ?? '?'})`;
    } catch { /* non-JSON body is itself informative */ }

    return { status: response.status, detail };
}

for (const modelId of modelIds) {
    const model = config.models[modelId];
    console.log(`\n=== ${modelId}  (${model.adapterModel} @ ${model.endpoint})`);
    for (const testCase of CASES) {
        let line;
        try {
            const { status, detail } = await probe(modelId, testCase);
            line = `${status === 200 ? 'ACCEPT ' : 'REJECT '} ${String(status).padEnd(4)} ${detail}`;
        } catch (error) {
            line = `ERROR       ${error.message}`;
        }
        console.log(`  ${testCase.name.padEnd(52)} ${line}`);
    }
}
