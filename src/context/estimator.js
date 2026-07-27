import { getEncoding } from 'js-tiktoken';

// Encodings are config-independent and expensive to build (multi-MB rank
// tables). Hoist to module level so reloadConfig() doesn't rebuild them.
const CL100K = getEncoding('cl100k_base');
const O200K = getEncoding('o200k_base');

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
