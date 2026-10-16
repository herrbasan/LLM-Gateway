/**
 * Gemini adapter — terminal interaction statuses.
 *
 * The Interactions API answers HTTP 200 for every terminal state; the outcome
 * lives in `status` (non-streaming) and in the `interaction.status_update` /
 * `interaction.completed` events (streaming). Google's states are
 * in_progress | requires_action | completed | incomplete | failed | cancelled.
 *
 * Before this was read, `failed` and `cancelled` were reported to the client as
 * finish_reason "stop" with whatever steps the dying interaction had produced —
 * a partial or empty answer claiming success. `incomplete` (the model used all
 * of max_output_tokens) reported "stop" too, rather than OpenAI's "length".
 *
 * Verified live against the API 2026-10-13: interaction.completed carries
 * `status: "requires_action"` for a pending tool call, so the event NAME is not
 * a success signal.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createAdapters } from '../src/core/adapters.js';

const adapters = createAdapters();
let realFetch = null;

afterEach(() => {
    if (realFetch) {
        globalThis.fetch = realFetch;
        realFetch = null;
    }
});

const MODEL = {
    type: 'chat',
    adapter: 'gemini',
    adapterModel: 'gemini-4-argon',
    endpoint: 'https://upstream.invalid/v1beta',
    apiKey: 'test-key',
    capabilities: { contextWindow: 1048576, maxOutputTokens: 65536 }
};

// chai 6 has no chai-as-promised here, so rejections are asserted directly.
async function expectRejection(promise, pattern) {
    try {
        await promise;
    } catch (error) {
        expect(error.message).to.match(pattern);
        return;
    }
    throw new Error(`expected a rejection matching ${pattern}`);
}

function stubJson(payload) {
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function stubStream(events) {
    const body = events
        .map(e => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join('');
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
    });
}

const textStep = (text) => ([
    { event_type: 'step.start', step: { type: 'model_output' } },
    { event_type: 'step.delta', delta: { type: 'text', text } },
    { event_type: 'step.stop' }
]);

function complete(status, usage = {}) {
    return {
        event_type: 'interaction.completed',
        interaction: { id: 'int_1', status, usage }
    };
}

const REQUEST = { messages: [{ role: 'user', content: 'hi' }] };

async function collect(generator) {
    const chunks = [];
    for await (const chunk of generator) chunks.push(chunk);
    return chunks;
}

describe('Gemini adapter — terminal interaction statuses', () => {
    it('non-streaming: a failed interaction is an error, not an empty success', async () => {
        stubJson({
            id: 'int_1',
            status: 'failed',
            steps: [{ type: 'thought', signature: 'sig' }]
        });

        await expectRejection(
            adapters.get('gemini').chatComplete(MODEL, REQUEST),
            /failed/
        );
    });

    it('non-streaming: a cancelled interaction is an error', async () => {
        stubJson({ id: 'int_1', status: 'cancelled', steps: [] });

        await expectRejection(
            adapters.get('gemini').chatComplete(MODEL, REQUEST),
            /cancelled/
        );
    });

    it('non-streaming: an incomplete interaction reports finish_reason "length"', async () => {
        stubJson({
            id: 'int_1',
            status: 'incomplete',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'half an ans' }] }],
            usage: { total_input_tokens: 10, total_output_tokens: 65536, total_tokens: 65546 }
        });

        const result = await adapters.get('gemini').chatComplete(MODEL, REQUEST);
        expect(result.choices[0].finish_reason).to.equal('length');
        expect(result.choices[0].message.content).to.equal('half an ans');
    });

    it('non-streaming: a completed interaction still reports "stop"', async () => {
        stubJson({
            id: 'int_1',
            status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }],
            usage: { total_input_tokens: 5, total_output_tokens: 1, total_tokens: 6 }
        });

        const result = await adapters.get('gemini').chatComplete(MODEL, REQUEST);
        expect(result.choices[0].finish_reason).to.equal('stop');
        expect(result.choices[0].message.content).to.equal('ok');
    });

    it('streaming: a stream that ends failed throws instead of finishing "stop"', async () => {
        stubStream([
            { event_type: 'interaction.created', interaction: { id: 'int_1', status: 'in_progress' } },
            ...textStep('partial'),
            { event_type: 'interaction.status_update', status: 'failed' },
            complete('failed')
        ]);

        await expectRejection(
            collect(adapters.get('gemini').streamComplete(MODEL, REQUEST)),
            /failed/
        );
    });

    it('streaming: an incomplete stream reports finish_reason "length"', async () => {
        stubStream([
            { event_type: 'interaction.created', interaction: { id: 'int_1', status: 'in_progress' } },
            ...textStep('truncated'),
            complete('incomplete', { total_input_tokens: 4, total_output_tokens: 65536, total_tokens: 65540 })
        ]);

        const chunks = await collect(adapters.get('gemini').streamComplete(MODEL, REQUEST));
        const terminal = chunks.find(c => c.choices?.[0]?.finish_reason);
        expect(terminal.choices[0].finish_reason).to.equal('length');
    });

    it('streaming: a completed stream still finishes "stop"', async () => {
        stubStream([
            { event_type: 'interaction.created', interaction: { id: 'int_1', status: 'in_progress' } },
            ...textStep('done'),
            complete('completed', { total_input_tokens: 4, total_output_tokens: 2, total_tokens: 6 })
        ]);

        const chunks = await collect(adapters.get('gemini').streamComplete(MODEL, REQUEST));
        const text = chunks.map(c => c.choices?.[0]?.delta?.content || '').join('');
        const terminal = chunks.find(c => c.choices?.[0]?.finish_reason);
        expect(text).to.equal('done');
        expect(terminal.choices[0].finish_reason).to.equal('stop');
    });
});
