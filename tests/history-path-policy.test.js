/**
 * The history path never refuses a request it can repair or drop.
 *
 * A client resends its whole history on every turn, so a gateway-side refusal is
 * not one failed request — it is every future request, identically, until the
 * client's history changes. That is a dead session, and the cost falls on the user
 * in money and time. So on the history path the gateway repairs what it can, drops
 * what it cannot represent, and logs it; the provider stays the only party that
 * decides a request is unacceptable.
 *
 * What this does NOT cover: a request the upstream itself refuses, and the one case
 * with genuinely nothing to send. Those still fail, loudly — the alternative is
 * inventing an answer, which corrupts silently instead of stopping.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createAdapters } from '../src/core/adapters.js';
import { instructionText, splitInstructions } from '../src/utils/system-messages.js';

const adapters = createAdapters();

const MODEL = {
    type: 'chat',
    adapter: 'anthropic',
    adapterModel: 'deepseek-flash',
    endpoint: 'https://upstream.invalid',
    apiKey: 'test-key',
    capabilities: { contextWindow: 200000, maxOutputTokens: 4096 }
};

let realFetch = null;
function captureUpstream() {
    const sent = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ error: { message: 'captured' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' }
        });
    };
    return sent;
}

afterEach(() => {
    if (realFetch) {
        globalThis.fetch = realFetch;
        realFetch = null;
    }
});

async function send(messages) {
    const sent = captureUpstream();
    try {
        await adapters.get('anthropic').chatComplete(MODEL, { messages, maxTokens: 256, stream: false });
    } catch { /* the stub rejects after the body is captured */ }
    return sent[0];
}

const call = (id, args) => ({ id, type: 'function', function: { name: 'ping', arguments: args } });

describe('history path — a malformed tool call is dropped, not fatal', () => {
    it('drops the call and its result, and still sends the request', async () => {
        // One bad arguments string used to 400 every future turn of the session.
        const body = await send([
            { role: 'user', content: 'Ping host a.' },
            { role: 'assistant', content: '', tool_calls: [call('call_bad', '{"host":')] },
            { role: 'tool', tool_call_id: 'call_bad', content: 'pong' },
            { role: 'user', content: 'Carry on.' }
        ]);

        expect(body, 'the request reaches the upstream').to.be.an('object');
        const flat = JSON.stringify(body.messages);
        expect(flat, 'the unreadable call is not sent').to.not.include('tool_use');
        expect(flat, 'and neither is its result').to.not.include('tool_result');
        expect(flat, 'the rest of the turn survives').to.include('Carry on.');
    });

    it('keeps a good call alongside a malformed one', async () => {
        const body = await send([
            { role: 'user', content: 'Ping both hosts.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [call('call_good', '{"host":"a"}'), call('call_bad', 'not json')]
            },
            { role: 'tool', tool_call_id: 'call_good', content: 'pong' }
        ]);

        const flat = JSON.stringify(body.messages);
        expect(flat).to.include('call_good');
        expect(flat).to.not.include('call_bad');
    });
});

describe('instruction messages — a shape surprise is not fatal', () => {
    it('keeps the text and drops a part that has no place in a system prompt', () => {
        const text = instructionText({
            role: 'system',
            content: [
                { type: 'text', text: 'Be terse. ' },
                { type: 'image', source: { type: 'url', url: 'https://example.invalid/x.png' } },
                { type: 'text', text: 'Answer in German.' }
            ]
        });
        expect(text).to.equal('Be terse. Answer in German.');
    });

    it('carries unexpected content as JSON instead of throwing', () => {
        expect(instructionText({ role: 'system', content: { note: 'object, not a string' } }))
            .to.equal('{"note":"object, not a string"}');
    });

    it('still splits a leading run into the system prompt', () => {
        const { systemPrompt, messages } = splitInstructions([
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'Hi.' }
        ]);
        expect(systemPrompt).to.equal('Be terse.');
        expect(messages.map(m => m.role)).to.deep.equal(['user']);
    });
});
