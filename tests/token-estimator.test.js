/**
 * The estimator's degenerate-input guard.
 *
 * js-tiktoken's BPE is quadratic on long runs of very few distinct characters
 * (measured 2026-10-10: 1.15s at 5KB, 4.5s at 10KB, 17.8s at 20KB of one
 * repeated glyph — a client payload of megabytes would have stalled the
 * synchronous request path for minutes). The guard diverts those shapes to the
 * char-ratio fallback; everything real — even hex at 16 distinct characters —
 * still goes through the exact encoder.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { getEncoding } from 'js-tiktoken';
import { TokenEstimator } from '../src/context/estimator.js';

const CL100K = getEncoding('cl100k_base');
const estimator = new TokenEstimator({});
const filler = (chars) => 'the quick brown fox jumps over the lazy dog '.repeat(Math.ceil(chars / 45)).slice(0, chars);

describe('TokenEstimator — degenerate-input guard', () => {
    it('diverts a megabyte of one repeated glyph to the ratio fallback, fast', async () => {
        const text = 'r'.repeat(1000000);
        const started = Date.now();
        const tokens = estimator.estimate(text);
        const elapsed = Date.now() - started;
        // cl100k 'rrrr' is exactly one token, so 0.25/char is exact here.
        expect(tokens).to.equal(250000);
        // Unguarded this encode runs for minutes; anything sane is well under 2s.
        expect(elapsed).to.be.lessThan(2000);
    });

    it('catches two alternating characters, not just one repeated', () => {
        // Measured equally quadratic — the pathology is merge starvation from
        // low diversity, not the glyph count.
        expect(estimator.estimate('ab'.repeat(100000))).to.equal(50000);
    });

    it('still encodes real text exactly, guard idle', () => {
        const text = filler(100000);
        expect(estimator.estimate(text)).to.equal(CL100K.encode(text).length);
    });

    it('still encodes hex exactly — low-ish diversity is not degenerate', () => {
        const text = '0123456789abcdef'.repeat(6250);
        expect(estimator.estimate(text)).to.equal(CL100K.encode(text).length);
    });

    it('leaves short strings to the exact encoder regardless of shape', () => {
        const text = 'r'.repeat(100);
        expect(estimator.estimate(text)).to.equal(CL100K.encode(text).length);
    });
});
