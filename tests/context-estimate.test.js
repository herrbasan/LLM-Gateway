/**
 * The context estimate — telemetry, not a gate.
 *
 * It answers "how much of the window does this payload occupy": context.usedTokens,
 * context.availableTokens, and the client's context gauge. It deliberately does NOT
 * decide what the gateway sends. The output budget belongs to the client and is
 * forwarded verbatim, and the only authority on whether a request fits is the
 * upstream that refuses it. The estimate still has to be honest — a wrong number in
 * telemetry is a wrong number in front of the user.
 *
 * The shape below is the 2026-10-08 miss: a 1M-window session whose payload was fat
 * with tool schemas, assistant tool_calls and reasoning traces, estimated at ≤664K
 * while DeepSeek counted 869K. It gated a request then; it only reports now, and the
 * same payload must still be counted.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ModelRouter } from '../src/core/model-router.js';
import { TokenEstimator } from '../src/context/estimator.js';

const WINDOW = 1000000;

describe('ModelRouter — context estimate covers the whole payload', () => {
    const MODEL = { capabilities: { contextWindow: WINDOW }, adapterModel: 'deepseek-flash' };
    const bare = Object.create(ModelRouter.prototype);
    bare.tokenEstimator = new TokenEstimator({});
    const usedTokens = async (messages, tools) =>
        (await bare._buildContextStats(messages, MODEL, null, tools)).usedTokens;
    // Varied filler — js-tiktoken's BPE degenerates on megabytes of a single
    // repeated glyph, which is not a shape real payloads have.
    const filler = (chars) => 'the quick brown fox jumps over the lazy dog '.repeat(Math.ceil(chars / 45));

    it('counts tool definitions, which travel outside the messages', async () => {
        const messages = [{ role: 'user', content: 'run it' }];
        const withoutTools = await usedTokens(messages);
        const withTools = await usedTokens(messages, [{
            type: 'function',
            function: { name: 'dispatch', description: filler(20000), parameters: { type: 'object' } }
        }]);
        expect(withTools).to.be.greaterThan(withoutTools + 4000);
    });

    it('counts assistant tool calls', async () => {
        const plain = await usedTokens([{ role: 'assistant', content: 'ok' }]);
        const withCalls = await usedTokens([{
            role: 'assistant',
            content: 'ok',
            tool_calls: [{ id: 'c1', function: { name: 'f', arguments: JSON.stringify({ blob: filler(20000) }) } }]
        }]);
        expect(withCalls).to.be.greaterThan(plain + 4000);
    });

    it('counts reasoning traces that ride alongside the answer', async () => {
        const plain = await usedTokens([{ role: 'assistant', content: 'ok' }]);
        const withReasoning = await usedTokens([{ role: 'assistant', content: 'ok', reasoning_content: filler(20000) }]);
        expect(withReasoning).to.be.greaterThan(plain + 4000);
    });

    it('counts the 2026-10-08 payload instead of under-reporting it', async () => {
        // Small visible text, fat invisible payload: the exact blind spot.
        const messages = [
            { role: 'user', content: 'continue' },
            { role: 'assistant', content: 'done', reasoning_content: filler(1300000) }
        ];
        const tools = [{
            type: 'function',
            function: { name: 't', description: filler(2000000), parameters: { type: 'object' } }
        }];
        // Roughly 730K tokens of filler. Ignoring tools and reasoning reported about
        // half of that, which is what let the session sail into its rejection.
        expect(await usedTokens(messages, tools)).to.be.greaterThan(600000);
    });
});
