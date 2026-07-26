// Verify P0.8: responses.js streaming transformer OpenAI-spec compliance.
// Simulates Responses-API SSE events and asserts:
//   1. usage fields translated (input_tokens -> prompt_tokens)
//   2. usage in a separate choices:[] chunk (not on finish chunk)
//   3. tool calls use tool_calls[] (not legacy function_call)
// Exits 0 on pass, 1 on fail.
import assert from 'node:assert';
import http from 'node:http';
import { createResponsesAdapter } from '../src/adapters/responses.js';

let failures = 0;
const check = (name, fn) => {
    try { fn(); console.log(`PASS  ${name}`); }
    catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
};

// Build a Responses-API SSE stream exercising text, tool call, and completion.
const sseBody = [
    'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"get_weather"}}',
    '',
    'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"location\\":"}',
    '',
    'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":" \\"Paris\\"}"}',
    '',
    'data: {"type":"response.output_text.delta","delta":"The weather is sunny."}',
    '',
    'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4-mini","status":"completed","usage":{"input_tokens":42,"output_tokens":17,"total_tokens":59}}}',
    '',
    'data: [DONE]',
    ''
].join('\r\n');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sseBody);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const adapter = createResponsesAdapter();
const modelConfig = {
    endpoint: `http://127.0.0.1:${port}`,
    apiKey: 'test',
    adapterModel: 'gpt-5.4-mini',
    capabilities: { contextWindow: 400000 }
};

const chunks = [];
try {
    for await (const chunk of adapter.streamComplete(modelConfig, { model: 'gpt-5.4-mini', input: 'weather?' })) {
        chunks.push(chunk);
    }
} finally {
    await new Promise(r => server.close(r));
}

const toolInit = chunks.find(c => c.choices?.[0]?.delta?.tool_calls?.[0]?.id);
check('tool call emitted as tool_calls[] with id/type/name', () => {
    assert.ok(toolInit, 'no tool_calls init chunk found');
    const tc = toolInit.choices[0].delta.tool_calls[0];
    assert.strictEqual(tc.id, 'call_1');
    assert.strictEqual(tc.type, 'function');
    assert.strictEqual(tc.function.name, 'get_weather');
    assert.strictEqual(typeof tc.index, 'number');
});

check('tool call argument deltas use tool_calls[] (not function_call)', () => {
    const argChunks = chunks.filter(c => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments);
    assert.ok(argChunks.length >= 2, `expected >=2 arg chunks, got ${argChunks.length}`);
    const args = argChunks.map(c => c.choices[0].delta.tool_calls[0].function.arguments).join('');
    assert.strictEqual(args, '{"location": "Paris"}');
    // Ensure NO legacy function_call anywhere
    const legacy = chunks.find(c => c.choices?.[0]?.delta?.function_call);
    assert.ok(!legacy, 'found legacy function_call delta');
});

const finishChunk = chunks.find(c => c.choices?.[0]?.finish_reason);
check('finish chunk has finish_reason and NO usage attached', () => {
    assert.ok(finishChunk, 'no finish chunk');
    assert.strictEqual(finishChunk.choices[0].finish_reason, 'stop');
    assert.ok(!finishChunk.usage, 'usage must not ride the finish chunk');
});

const usageChunk = chunks.find(c => Array.isArray(c.choices) && c.choices.length === 0 && c.usage);
check('usage emitted in separate choices:[] chunk with translated fields', () => {
    assert.ok(usageChunk, 'no separate usage chunk found');
    assert.strictEqual(usageChunk.usage.prompt_tokens, 42);
    assert.strictEqual(usageChunk.usage.completion_tokens, 17);
    assert.strictEqual(usageChunk.usage.total_tokens, 59);
    assert.ok(!('input_tokens' in usageChunk.usage), 'untranslated input_tokens leaked');
});

console.log(failures === 0 ? 'RESPONSES_SPEC_PASS' : `RESPONSES_SPEC_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
