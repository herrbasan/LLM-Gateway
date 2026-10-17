/**
 * Tool containment — "report, don't block".
 *
 * A stateless client resends its whole request every turn, so a provider refusing one
 * tool is not a failed call: it is every future call, identically, until the client's
 * payload changes. That is how a single bad tool schema ended a conversation on
 * 2026-10-17 (Gemini refused VS Code's `ask_user` schema).
 *
 * The policy under test: a rejection that NAMES a tool drops that tool and retries,
 * the turn completes, and the provider's own words are logged at `warn`. Everything
 * else — auth, rate limits, context length, content refusals, history shape — stays
 * fatal, because dropping a message would silently change what the model saw.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import {
    rejectedToolName,
    dropToolByName,
    sendWithToolContainment
} from '../src/utils/tool-containment.js';
import { createAdapters } from '../src/core/adapters.js';

const GEMINI_REJECTION = 'HTTP Error 400: Bad Request: {"error":{"message":"Invalid schema in function tool \'ask_user\' parameters: specifies required field \'oneOf\' which is not defined in properties.","code":"invalid_request"}}';
const OPENAI_REJECTION = 'HTTP Error 400: Bad Request: {"error":{"message":"Invalid schema for function \'ask_user\': required field missing."}}';

const openAiTool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
const payloadWith = (...names) => ({ tools: names.map(openAiTool) });

let seq = 0;
// Each test gets its own adapter|model key so the refusal cache cannot bleed.
const freshModel = () => `model-${++seq}`;

describe('rejectedToolName', () => {
    it('reads the provider wordings that name a tool', () => {
        expect(rejectedToolName(GEMINI_REJECTION, payloadWith('other'))).to.equal('ask_user');
        expect(rejectedToolName(OPENAI_REJECTION, payloadWith('other'))).to.equal('ask_user');
    });

    it('resolves an index into our own payload', () => {
        const payload = payloadWith('first', 'second');
        expect(rejectedToolName('HTTP 400: tools.1.custom.input_schema: invalid', payload)).to.equal('second');
        expect(rejectedToolName('HTTP 400: tools[0] invalid', payload)).to.equal('first');
    });

    it('returns null for a rejection that names no tool', () => {
        // Dropping anything here would be a guess about someone else's failure.
        expect(rejectedToolName('HTTP 400: Invalid JSON payload: syntax error in request body', payloadWith('a'))).to.equal(null);
        expect(rejectedToolName('HTTP 400: maximum context length is 1048576 tokens', payloadWith('a'))).to.equal(null);
        expect(rejectedToolName('HTTP 401: invalid api key', payloadWith('a'))).to.equal(null);
        expect(rejectedToolName(undefined, payloadWith('a'))).to.equal(null);
    });
});

describe('dropToolByName', () => {
    it('drops the named tool and keeps the rest', () => {
        const payload = payloadWith('keep', 'drop');
        expect(dropToolByName(payload, 'drop')).to.be.true;
        expect(payload.tools.map(t => t.function.name)).to.deep.equal(['keep']);
    });

    it('removes the tools key once nothing is offered', () => {
        const payload = payloadWith('only');
        expect(dropToolByName(payload, 'only')).to.be.true;
        expect(payload).to.not.have.property('tools');
    });

    it('clears a tool_choice that names the dropped tool', () => {
        const payload = { ...payloadWith('a', 'b'), tool_choice: { type: 'function', function: { name: 'a' } } };
        expect(dropToolByName(payload, 'a')).to.be.true;
        expect(payload).to.not.have.property('tool_choice');
    });

    it('reports a name the payload does not offer', () => {
        expect(dropToolByName(payloadWith('a'), 'ghost')).to.be.false;
    });

    it('handles the anthropic and gemini tool shapes too', () => {
        const anthropic = { tools: [{ name: 'a', input_schema: {} }, { name: 'b', input_schema: {} }] };
        expect(dropToolByName(anthropic, 'a')).to.be.true;
        expect(anthropic.tools.map(t => t.name)).to.deep.equal(['b']);

        const gemini = { tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }] };
        expect(dropToolByName(gemini, 'a')).to.be.true;
        expect(gemini.tools.map(t => t.name)).to.deep.equal(['b']);
    });
});

describe('sendWithToolContainment', () => {
    it('drops the refused tool and completes the turn', async () => {
        const model = freshModel();
        const payload = payloadWith('ask_user', 'storage_read');
        const attempts = [];

        const response = await sendWithToolContainment({
            adapter: 'test',
            model,
            payload,
            send: async (body) => {
                attempts.push(body.tools.map(t => t.function.name));
                if (attempts.length === 1) throw new Error(GEMINI_REJECTION);
                return { ok: true };
            }
        });

        expect(response).to.deep.equal({ ok: true });
        expect(attempts, 'one rejected attempt, then a reduced one').to.deep.equal([
            ['ask_user', 'storage_read'],
            ['storage_read']
        ]);
    });

    it('remembers the refusal for later requests to that model', async () => {
        const model = freshModel();
        let firstAttempts = 0;
        await sendWithToolContainment({
            adapter: 'test',
            model,
            payload: payloadWith('ask_user', 'storage_read'),
            send: async () => {
                firstAttempts++;
                if (firstAttempts === 1) throw new Error(GEMINI_REJECTION);
                return { ok: true };
            }
        });

        // A later request must not pay the rejected round trip again.
        const sent = [];
        await sendWithToolContainment({
            adapter: 'test',
            model,
            payload: payloadWith('ask_user', 'storage_read'),
            send: async (body) => { sent.push(body.tools.map(t => t.function.name)); return { ok: true }; }
        });

        expect(sent, 'pre-dropped, one attempt').to.deep.equal([['storage_read']]);
    });

    it('re-offers a tool whose schema has changed since it was refused', async () => {
        // A client can fix a bad schema. Refusing the NAME forever would keep the tool
        // unavailable until the process restarted, long after the cause was gone.
        const model = freshModel();
        let attempts = 0;
        await sendWithToolContainment({
            adapter: 'test',
            model,
            payload: payloadWith('ask_user', 'storage_read'),
            send: async () => {
                attempts++;
                if (attempts === 1) throw new Error(GEMINI_REJECTION);
                return { ok: true };
            }
        });

        // Same name, corrected schema: it must be offered, not pre-dropped.
        const corrected = {
            tools: [
                { type: 'function', function: { name: 'ask_user', parameters: { type: 'object', properties: { m: { type: 'string' } } } } },
                openAiTool('storage_read')
            ]
        };
        const sent = [];
        await sendWithToolContainment({
            adapter: 'test',
            model,
            payload: corrected,
            send: async (body) => { sent.push(body.tools.map(t => t.function.name)); return { ok: true }; }
        });

        expect(sent, 'the corrected schema gets its chance').to.deep.equal([['ask_user', 'storage_read']]);
    });

    it('leaves a rejection that names no tool untouched', async () => {
        let attempts = 0;
        const error = new Error('HTTP Error 400: Bad Request: maximum context length is 1048576 tokens');

        let caught = null;
        try {
            await sendWithToolContainment({
                adapter: 'test',
                model: freshModel(),
                payload: payloadWith('a'),
                send: async () => { attempts++; throw error; }
            });
        } catch (thrown) {
            caught = thrown;
        }

        expect(caught, 'the original error is what the caller sees').to.equal(error);
        expect(attempts, 'no retry — nothing was ours to drop').to.equal(1);
    });

    it('does not retry when the named tool was not offered', async () => {
        let attempts = 0;
        let caught = null;
        try {
            await sendWithToolContainment({
                adapter: 'test',
                model: freshModel(),
                payload: payloadWith('a'),
                send: async () => {
                    attempts++;
                    throw new Error('HTTP 400: Invalid schema in function tool \'ghost\' parameters: bad');
                }
            });
        } catch (thrown) {
            caught = thrown;
        }
        expect(caught).to.be.an('error');
        expect(attempts).to.equal(1);
    });

    it('gives up after three drops instead of looping', async () => {
        // Each rejection names a DIFFERENT remaining tool, so the loop has something
        // to drop each time; the guard is what ends it.
        let attempts = 0;
        let caught = null;
        try {
            await sendWithToolContainment({
                adapter: 'test',
                model: freshModel(),
                payload: payloadWith('a', 'b', 'c', 'd'),
                send: async (body) => {
                    attempts++;
                    const name = body.tools[0].function.name;
                    throw new Error(`HTTP 400: Invalid schema in function tool '${name}' parameters: bad`);
                }
            });
        } catch (thrown) {
            caught = thrown;
        }
        expect(caught).to.be.an('error');
        expect(attempts, 'initial + three drops, then the guard').to.equal(4);
    });
});

describe('adapters — a refused tool does not end the turn', () => {
    const adapters = createAdapters();
    let realFetch = null;
    afterEach(() => {
        if (realFetch) { globalThis.fetch = realFetch; realFetch = null; }
    });

    /** First response refuses a tool by name, the second succeeds. */
    function stubRefuseThenSucceed(successBody) {
        const bodies = [];
        let call = 0;
        realFetch = globalThis.fetch;
        globalThis.fetch = async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            call++;
            if (call === 1) {
                return new Response(JSON.stringify({
                    error: {
                        message: "Invalid schema in function tool 'ask_user' parameters: specifies required field 'oneOf' which is not defined in properties.",
                        code: 'invalid_request'
                    }
                }), { status: 400, headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify(successBody), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        return bodies;
    }

    const TOOLS = [
        { type: 'function', function: { name: 'ask_user', description: 'd', parameters: { type: 'object', properties: { m: { type: 'string' } } } } },
        { type: 'function', function: { name: 'keep_me', description: 'd', parameters: { type: 'object', properties: { m: { type: 'string' } } } } }
    ];

    it('gemini', async () => {
        const bodies = stubRefuseThenSucceed({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }] });
        const model = {
            type: 'chat', adapter: 'gemini', adapterModel: 'gemini-4-argon',
            endpoint: 'https://upstream.invalid/v1beta', apiKey: 'k',
            capabilities: { contextWindow: 1000000, maxOutputTokens: 1000 }
        };

        const response = await adapters.get('gemini').chatComplete(model, {
            messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, maxTokens: 32, stream: false
        });

        expect(bodies).to.have.length(2);
        expect(bodies[1].tools.map(t => t.name)).to.deep.equal(['keep_me']);
        expect(response.choices[0].message.content).to.equal('hi');
    });

    it('openai', async () => {
        const bodies = stubRefuseThenSucceed({
            id: 'x', object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
        const model = {
            type: 'chat', adapter: 'openai', adapterModel: 'm',
            endpoint: 'https://upstream.invalid/v1', apiKey: 'k',
            capabilities: { contextWindow: 100000, maxOutputTokens: 1000 }
        };

        await adapters.get('openai').chatComplete(model, {
            messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, maxTokens: 32, stream: false
        });

        expect(bodies[1].tools.map(t => t.function.name)).to.deep.equal(['keep_me']);
    });

    it('anthropic (composed with the output-budget retry)', async () => {
        const bodies = stubRefuseThenSucceed({
            id: 'msg_1', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 }
        });
        const model = {
            type: 'chat', adapter: 'anthropic', adapterModel: 'deepseek-flash',
            endpoint: 'https://upstream.invalid', apiKey: 'k',
            capabilities: { contextWindow: 100000, maxOutputTokens: 1000 }
        };

        const response = await adapters.get('anthropic').chatComplete(model, {
            messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, maxTokens: 32, stream: false
        });

        expect(bodies).to.have.length(2);
        expect(bodies[1].tools.map(t => t.name)).to.deep.equal(['keep_me']);
        expect(response.choices[0].message.content).to.equal('hi');
    });
});
