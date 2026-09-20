/**
 * Output-budget retry (Anthropic-protocol adapters).
 *
 * DeepSeek rejects a request when prompt + max_tokens exceeds the context window —
 * by 50 tokens in the 2026-09-19 incident — and a stateless client resends the
 * identical request forever, so the session dies on an arithmetic detail. The
 * rejection names both numbers it used, so the retry needs no estimate.
 */

import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { parseContextOverflow, sendWithBudgetRetry } from '../src/adapters/anthropic.js';

const REJECTION = 'HTTP Error 400: Bad Request: {"error":{"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1048626 tokens (664626 in the messages, 384000 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error"}}';

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

describe('parseContextOverflow', () => {
    it('reads the numbers the upstream reported', () => {
        expect(parseContextOverflow(REJECTION)).to.deep.equal({
            contextWindow: 1048576,
            promptTokens: 664626,
            requestedCompletion: 384000
        });
    });

    it('ignores unrelated failures', () => {
        expect(parseContextOverflow('HTTP Error 400: {"error":{"message":"tool_use ids must be unique"}}')).to.equal(null);
        expect(parseContextOverflow(undefined)).to.equal(null);
    });
});

describe('sendWithBudgetRetry', () => {
    let attempts;

    beforeEach(() => { attempts = []; });

    const failing = (thenSucceed) => async (body) => {
        attempts.push({ ...body });
        if (attempts.length === 1 && !thenSucceed) throw new Error(REJECTION);
        return { ok: true, body };
    };

    it('shrinks the output budget to what the window has left and sends again', async () => {
        const send = failing(false);
        const body = { model: 'deepseek-flash', max_tokens: 384000 };

        const response = await sendWithBudgetRetry(send, body);

        expect(attempts).to.have.length(2);
        // 1048576 - 664626 - 64 headroom
        expect(attempts[1].max_tokens).to.equal(383886);
        expect(response.ok).to.equal(true);
    });

    it('passes a successful first attempt straight through', async () => {
        const send = failing(true);
        const body = { model: 'deepseek-flash', max_tokens: 1000 };

        await sendWithBudgetRetry(send, body);

        expect(attempts).to.have.length(1);
    });

    it('does not retry a failure that is not about the context window', async () => {
        const send = async () => { throw new Error('HTTP Error 400: {"error":{"message":"tool_use ids must be unique"}}'); };

        await expectRejection(sendWithBudgetRetry(send, { max_tokens: 10 }), /tool_use ids must be unique/);
    });

    it('gives up when the prompt alone fills the window', async () => {
        const send = async () => {
            throw new Error('maximum context length is 1000 tokens. However, you requested 1200 tokens (995 in the messages, 205 in the completion)');
        };

        await expectRejection(sendWithBudgetRetry(send, { max_tokens: 205 }), /maximum context length/);
    });

    it('keeps the thinking budget under the shrunk max_tokens', async () => {
        const send = failing(false);
        const body = { max_tokens: 384000, thinking: { type: 'enabled', budget_tokens: 200000 } };

        await sendWithBudgetRetry(send, body);

        expect(attempts[1].max_tokens).to.equal(383886);
        expect(attempts[1].thinking.budget_tokens).to.be.lessThan(attempts[1].max_tokens);
    });

    it('propagates the second failure when the retry does not help', async () => {
        const send = async (body) => {
            attempts.push({ ...body });
            if (attempts.length === 1) throw new Error(REJECTION);
            throw new Error('HTTP Error 400: still too long');
        };

        await expectRejection(sendWithBudgetRetry(send, { max_tokens: 384000 }), /still too long/);
        expect(attempts).to.have.length(2);
    });
});
