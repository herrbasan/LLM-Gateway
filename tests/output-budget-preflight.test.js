/**
 * The pre-flight half of the context-window story.
 *
 * `sendWithBudgetRetry` (output-budget-retry.test.js) is the rescue: it acts on
 * the upstream's authoritative rejection. This is the prevention — a budget that
 * cannot fit is shrunk before dispatch, so the rescue is not what runs on every
 * single turn of a long session.
 *
 * The motivating shape is real: a 1M-window model declaring a 384K output cap.
 * 1,000,000 - 384,000 = 616,000, so every prompt past 616K makes the request
 * unsatisfiable no matter what the client asks for.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ModelRouter } from '../src/core/model-router.js';

const WINDOW = 1000000;
const BUDGET = 384000;

const fit = (maxTokens, context) =>
    ModelRouter.prototype._fitMaxTokensToWindow.call({}, maxTokens, context);

describe('ModelRouter — output budget pre-flight', () => {
    describe('leaves a satisfiable request alone', () => {
        it('passes the budget through when the prompt is small', () => {
            expect(fit(BUDGET, { windowSize: WINDOW, usedTokens: 1000 })).to.equal(BUDGET);
        });

        it('passes the budget through when it exactly fits the headroom', () => {
            // 1,000,000 - 384,000 - 64 headroom = a prompt of exactly 615,936.
            expect(fit(BUDGET, { windowSize: WINDOW, usedTokens: WINDOW - BUDGET - 64 })).to.equal(BUDGET);
        });

        it('leaves null null — a model that declares no budget declares none', () => {
            expect(fit(null, { windowSize: WINDOW, usedTokens: 900000 })).to.equal(null);
        });
    });

    describe('shrinks a request that cannot fit', () => {
        it('cuts the budget to the room the prompt leaves', () => {
            // The real failure: 788,153 prompt tokens against a 384K budget.
            expect(fit(BUDGET, { windowSize: WINDOW, usedTokens: 788153 })).to.equal(WINDOW - 788153 - 64);
        });

        it('keeps the sum inside the window at every prompt size', () => {
            for (const used of [616000, 700000, 788153, 870133, 999000]) {
                const total = used + fit(BUDGET, { windowSize: WINDOW, usedTokens: used });
                expect(total, `prompt ${used}`).to.be.at.most(WINDOW);
            }
        });

        it('shrinks a client-supplied budget too, not only the declared one', () => {
            // A client asking for less than the model allows still gets clamped
            // when the prompt leaves less than it asked for.
            expect(fit(100000, { windowSize: WINDOW, usedTokens: 950000 })).to.equal(WINDOW - 950000 - 64);
        });
    });

    describe('refuses to invent a number', () => {
        it('leaves the budget alone when the estimate is missing', () => {
            // An absent estimate is not evidence of overflow.
            expect(fit(BUDGET, { windowSize: WINDOW })).to.equal(BUDGET);
            expect(fit(BUDGET, { usedTokens: 800000 })).to.equal(BUDGET);
            expect(fit(BUDGET, undefined)).to.equal(BUDGET);
        });

        it('leaves the budget alone when the estimate is NaN', () => {
            expect(fit(BUDGET, { windowSize: WINDOW, usedTokens: NaN })).to.equal(BUDGET);
            expect(fit(BUDGET, { windowSize: NaN, usedTokens: 800000 })).to.equal(BUDGET);
        });

        it('does not clamp to a nonsense budget when the prompt fills the window', () => {
            // Nothing is left to give. Passing a made-up budget would look like
            // success locally and fail upstream on a different rule; the honest
            // answer is to let the upstream reject it with its own numbers.
            expect(fit(BUDGET, { windowSize: WINDOW, usedTokens: WINDOW })).to.equal(BUDGET);
            expect(fit(BUDGET, { windowSize: WINDOW, usedTokens: WINDOW - 10 })).to.equal(BUDGET);
        });
    });

    describe('handles a model with a small window', () => {
        it('never clamps a budget that already fits a 200K window', () => {
            expect(fit(64000, { windowSize: 200000, usedTokens: 120000 })).to.equal(64000);
        });

        it('still clamps when a small window is genuinely exceeded', () => {
            expect(fit(64000, { windowSize: 200000, usedTokens: 180000 })).to.equal(200000 - 180000 - 64);
        });
    });
});