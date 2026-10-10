import { getEncoding } from 'js-tiktoken';

// Encodings are config-independent and expensive to build (multi-MB rank
// tables). Hoist to module level so reloadConfig() doesn't rebuild them.
const CL100K = getEncoding('cl100k_base');
const O200K = getEncoding('o200k_base');

// The encode below is synchronous and sits in the request path, and
// js-tiktoken's BPE is quadratic on long runs of very few distinct
// characters: measured 1.15s at 5KB, 4.5s at 10KB, 17.8s at 20KB of one
// repeated glyph (and equally for two alternating ones) — a multi-megabyte
// payload of that shape would stall every request the gateway is serving.
// Real text never looks like that: even hex, a bare 16 distinct characters,
// encodes 100KB in 22ms. So anything at or under a handful of distinct
// characters is garbage for estimation purposes — the char-ratio fallback is
// exact for repeated ASCII (cl100k 'rrrr' is one token), and where it
// under-counts, the upstream's context-window rejection remains the backstop.
const DEGENERATE_MIN_CHARS = 4000;
const DEGENERATE_DISTINCT_CHARS = 6;

function distinctCharCountAtMost(text, limit) {
    const seen = new Set();
    for (let i = 0; i < text.length; i++) {
        seen.add(text.charCodeAt(i));
        if (seen.size > limit) return false;
    }
    return true;
}

export class TokenEstimator {
    constructor(config) {
        this.fallbackRatio = config?.tokenEstimation?.fallbackRatio ?? 0.25;
    }

    /**
     * Estimates tokens for a given text via tiktoken (synchronous).
     * No upstream API calls — the provider bills for those.
     */
    estimate(input, _adapter, requestedModel) {
        if (!input) return 0;

        let text = input;
        let imageCost = 0;

        if (Array.isArray(input)) {
            // If it's an array of OpenAI content parts
            text = input.map(part => part.type === 'text' ? part.text : '').join('\n');
            // Calculate image token cost based on detail level
            imageCost = input
                .filter(part => part.type === 'image_url')
                .reduce((total, part) => {
                    const detail = part.image_url?.detail ?? 'auto';
                    const cost = detail === 'high' ? 255 : 85;
                    return total + cost;
                }, 0);
        }

        if (!text) return imageCost;

        if (text.length >= DEGENERATE_MIN_CHARS && distinctCharCountAtMost(text, DEGENERATE_DISTINCT_CHARS)) {
            return Math.ceil(text.length * this.fallbackRatio) + imageCost;
        }

        // tiktoken (synchronous). On a lone-surrogate encode failure, fall back
        // to the char-ratio heuristic — but log nothing here (hot path); the
        // estimate is telemetry-only and a wrong number is visible downstream.
        let textTokens = 0;
        try {
            const isO200k = typeof requestedModel === 'string' && /gpt-4o|\bo1\b|o200k/.test(requestedModel);
            const encoding = isO200k ? O200K : CL100K;
            textTokens = encoding.encode(text).length;
        } catch {
            textTokens = Math.ceil(text.length * this.fallbackRatio);
        }

        return textTokens + imageCost;
    }
}
