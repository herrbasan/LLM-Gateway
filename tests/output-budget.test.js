/**
 * The output budget — the client's number, forwarded verbatim, or nothing.
 *
 * This is the regression guard for the 2026-10-16 incident. The gateway used to
 * request `capabilities.maxOutputTokens` whenever the client sent no budget, so a
 * Copilot turn on a long session sent "745,526 in the messages, 384,000 in the
 * completion" against a 1,048,576-token window — impossible by construction, and
 * rejected on every turn of that session (50 warnings in 44 minutes). The window
 * was never the problem: nobody had asked for 384,000 tokens, and the gateway had
 * no basis to ask for it. A model's ceiling is a fact about the model; it is
 * published in /v1/models and enforces nothing.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { resolveOutputBudget } from '../src/core/model-router.js';

const DEEPSEEK = { capabilities: { contextWindow: 1048576, maxOutputTokens: 384000 } };
const KIMI = { capabilities: { contextWindow: 1048576, maxOutputTokens: 131072 }, defaultMaxTokens: 131072 };

describe('resolveOutputBudget', () => {
    it('forwards the client budget, preferring max_completion_tokens', () => {
        expect(resolveOutputBudget({ max_completion_tokens: 2048, max_tokens: 1024 }, DEEPSEEK)).to.equal(2048);
        expect(resolveOutputBudget({ max_tokens: 1024 }, DEEPSEEK)).to.equal(1024);
        expect(resolveOutputBudget({ maxTokens: 512 }, DEEPSEEK)).to.equal(512);
    });

    it('sends nothing when the client sends nothing, even with a declared ceiling', () => {
        // The 2026-10-16 regression: the ceiling must not become a request.
        expect(resolveOutputBudget({}, DEEPSEEK)).to.equal(null);
        expect(resolveOutputBudget({}, { capabilities: { maxOutputTokens: 65536 } })).to.equal(null);
    });

    it('uses the declared default only where an upstream requires the field', () => {
        // Kimi and native Anthropic answer 400 without it (probed live 2026-10-16).
        expect(resolveOutputBudget({}, KIMI)).to.equal(131072);
    });

    it('lets the client override the declared default', () => {
        expect(resolveOutputBudget({ max_tokens: 4096 }, KIMI)).to.equal(4096);
    });

    it('tolerates a missing model config', () => {
        expect(resolveOutputBudget({})).to.equal(null);
    });
});
