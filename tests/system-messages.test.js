/**
 * System/developer messages on providers with a single top-level system field.
 *
 * Copilot appends a system message after the model's last answer. The Anthropic
 * and Gemini adapters used to keep only the first system message and delete the
 * rest, so the outbound history ended on the model's own answer — which DeepSeek
 * rejects with "content[].thinking ... must be passed back" and Kimi answers
 * with an empty completion (both reproduced live, 2026-10-03).
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createAdapters } from '../src/core/adapters.js';
import { splitInstructions } from '../src/utils/system-messages.js';
import { describeRequestShape } from '../src/adapters/anthropic.js';

const adapters = createAdapters();

const ANTHROPIC_MODEL = {
    type: 'chat',
    adapter: 'anthropic',
    adapterModel: 'deepseek-flash',
    endpoint: 'https://upstream.invalid',
    apiKey: 'test-key',
    // As configured in config.json for deepseek-flash-chat: the provider requires an
    // assistant turn's thinking to be echoed back.
    capabilities: { contextWindow: 200000, maxOutputTokens: 4096, priorReasoning: 'required-with-tools' }
};

const GEMINI_MODEL = {
    type: 'chat',
    adapter: 'gemini',
    adapterModel: 'gemini-test',
    endpoint: 'https://upstream.invalid/v1beta',
    apiKey: 'test-key',
    capabilities: { contextWindow: 200000 }
};

// Captures the outbound body, then rejects so no response parsing is involved.
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

async function sendAndCapture(adapterName, model, request) {
    const sent = captureUpstream();
    let error = null;
    try {
        await adapters.get(adapterName).chatComplete(model, request);
    } catch (err) {
        error = err;
    }
    expect(sent, `upstream call failed before sending: ${error?.message}`).to.have.length(1);
    return sent[0];
}

const COPILOT_TAIL = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'Say hi.' },
    { role: 'assistant', content: 'Hi.' },
    { role: 'system', content: 'Reminder: you have open tasks.' }
];

describe('splitInstructions', () => {
    it('joins the leading system/developer run into the system prompt', () => {
        const { systemPrompt, messages } = splitInstructions([
            { role: 'system', content: 'A' },
            { role: 'developer', content: [{ type: 'text', text: 'B' }, { type: 'text', text: 'C' }] },
            { role: 'user', content: 'hi' }
        ]);
        expect(systemPrompt).to.equal('A\n\nBC');
        expect(messages).to.deep.equal([{ role: 'user', content: 'hi' }]);
    });

    it('keeps a later system/developer message in place as a user turn', () => {
        const { systemPrompt, messages } = splitInstructions(COPILOT_TAIL);
        expect(systemPrompt).to.equal('You are a coding assistant.');
        expect(messages.map(m => m.role)).to.deep.equal(['user', 'assistant', 'user']);
        expect(messages[2].content).to.equal('Reminder: you have open tasks.');
    });

    it('returns a null system prompt when there is none', () => {
        const { systemPrompt, messages } = splitInstructions([{ role: 'user', content: 'hi' }]);
        expect(systemPrompt).to.equal(null);
        expect(messages).to.have.length(1);
    });

    it('drops a non-text part instead of refusing the request', () => {
        // Refusing ended the session: the client resends this message every turn.
        const { systemPrompt } = splitInstructions([
            { role: 'system', content: [{ type: 'image_url', image_url: { url: 'x' } }] }
        ]);
        expect(systemPrompt, 'nothing textual was left').to.equal('');
    });

    it('keeps the text around a dropped part', () => {
        const { systemPrompt } = splitInstructions([
            { role: 'system', content: [{ type: 'text', text: 'Be terse. ' }, { type: 'tool_use', id: 'x' }] }
        ]);
        expect(systemPrompt).to.equal('Be terse. ');
    });
});

describe('Anthropic adapter — system messages', () => {
    it('never ends the outbound history on the assistant when a system message trails it', async () => {
        const body = await sendAndCapture('anthropic', ANTHROPIC_MODEL, { messages: COPILOT_TAIL, maxTokens: 256 });
        expect(body.system).to.equal('You are a coding assistant.');
        expect(body.messages.map(m => m.role)).to.deep.equal(['user', 'assistant', 'user']);
        expect(body.messages[2].content).to.deep.equal([{ type: 'text', text: 'Reminder: you have open tasks.' }]);
    });

    it('sends a leading developer message as the system prompt', async () => {
        const body = await sendAndCapture('anthropic', ANTHROPIC_MODEL, {
            messages: [{ role: 'developer', content: 'Be terse.' }, { role: 'user', content: 'hi' }],
            maxTokens: 256
        });
        expect(body.system).to.equal('Be terse.');
        expect(body.messages.map(m => m.role)).to.deep.equal(['user']);
    });
});

describe('Gemini adapter — system messages', () => {
    it('keeps a trailing system message as a user_input step', async () => {
        const body = await sendAndCapture('gemini', GEMINI_MODEL, { messages: COPILOT_TAIL });
        expect(body.system_instruction).to.equal('You are a coding assistant.');
        expect(body.input.map(s => s.type)).to.deep.equal(['user_input', 'model_output', 'user_input']);
    });

    it('flattens array system content to text instead of "[object Object]"', async () => {
        const body = await sendAndCapture('gemini', GEMINI_MODEL, {
            messages: [
                { role: 'system', content: [{ type: 'text', text: 'Be terse.' }] },
                { role: 'user', content: 'hi' }
            ]
        });
        expect(body.system_instruction).to.equal('Be terse.');
    });
});

describe('Anthropic adapter — history that ends on a finished answer', () => {
    const ANSWERED = [
        { role: 'user', content: 'Say hi.' },
        { role: 'assistant', content: 'Hi.', reasoning_content: 'Greet back.' }
    ];

    it('sends the trailing turn with its reasoning, instead of refusing the request', async () => {
        // DeepSeek accepts this shape (probed 2026-10-16). The gateway used to
        // refuse it with ENDS_ON_ANSWER — rejecting a request that would have
        // succeeded, on every turn of the session.
        const body = await sendAndCapture('anthropic', ANTHROPIC_MODEL, { messages: ANSWERED, maxTokens: 256 });

        const last = body.messages[body.messages.length - 1];
        expect(last.role).to.equal('assistant');
        expect(last.content.some(b => b.type === 'thinking' && b.thinking === 'Greet back.'),
            'the reasoning the provider requires is kept').to.be.true;
        expect(last.content.some(b => b.type === 'text' && b.text === 'Hi.')).to.be.true;
    });

    it('does the same on the streaming path', async () => {
        const sent = captureUpstream();
        try {
            for await (const _chunk of adapters.get('anthropic').streamComplete(ANTHROPIC_MODEL, { messages: ANSWERED, maxTokens: 256 })) {
                // the stub rejects after capturing the body
            }
        } catch { /* captured */ }

        expect(sent, 'the request reaches the upstream').to.have.length(1);
        const last = sent[0].messages[sent[0].messages.length - 1];
        expect(last.content.some(b => b.type === 'thinking')).to.be.true;
    });

    it('adds an empty block to a trailing turn that has no reasoning', async () => {
        const body = await sendAndCapture('anthropic', ANTHROPIC_MODEL, {
            messages: [{ role: 'user', content: 'Count to three.' }, { role: 'assistant', content: 'One,' }],
            maxTokens: 256
        });

        const last = body.messages[body.messages.length - 1];
        expect(last.content.filter(b => b.type === 'thinking'), 'the provider requires one').to.have.length(1);
        expect(last.content[0].thinking).to.equal('');
        expect(body.messages.map(m => m.role)).to.deep.equal(['user', 'assistant']);
    });
});

describe('describeRequestShape', () => {
    it('summarises turns and thinking health without any text', () => {
        const shape = describeRequestShape({
            max_tokens: 512,
            system: 'abc',
            tools: [{ name: 't' }],
            output_config: { effort: 'low' },
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'secret question' }] },
                { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'secret answer' }] },
                { role: 'user', content: [{ type: 'text', text: 'more' }] }
            ]
        });
        expect(shape).to.deep.equal({
            messageCount: 3,
            lastTurns: ['user:text', 'assistant:thinking+text', 'user:text'],
            thinkingBlocks: { total: 1, empty: 1, unsigned: 1 },
            systemChars: 3,
            toolCount: 1,
            maxTokens: 512,
            thinking: null,
            outputConfig: { effort: 'low' }
        });
        expect(JSON.stringify(shape)).to.not.include('secret');
    });
});
