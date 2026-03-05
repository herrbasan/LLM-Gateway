import { getEncoding } from 'js-tiktoken';

export class TokenEstimator {
    constructor(config) {
        this.fallbackRatio = config?.tokenEstimation?.fallbackRatio || 0.25;
        this.cl100k = getEncoding('cl100k_base');
        this.o200k = getEncoding('o200k_base');
    }

    /**
     * Estimates tokens for a given text using provider's native count if available,
     * otherwise falls back to a character heuristic.
     */
    async estimate(input, adapter, requestedModel) {
        if (!input) return 0;

        let text = input;
        let imageCost = 0;

        if (Array.isArray(input)) {
            // If it's an array of OpenAI content parts
            text = input.map(part => part.type === 'text' ? part.text : '').join('\n');
            // Calculate image token cost based on detail level
            // OpenAI: low=85, high=170 base + tiles (~255 for typical image)
            imageCost = input
                .filter(part => part.type === 'image_url')
                .reduce((total, part) => {
                    const detail = part.image_url?.detail || 'auto';
                    // low: 85 tokens, high: ~255 tokens (base 170 + tiles), auto: 85 tokens
                    const cost = detail === 'high' ? 255 : 85;
                    return total + cost;
                }, 0);
        }

        if (!text) return imageCost;

        // 1. Try Provider Native
        if (adapter && typeof adapter.countTokens === 'function') {
            try {
                // Provider native should preferably handle arrays if they support it
                const nativeCount = await adapter.countTokens(input, requestedModel);
                if (nativeCount !== null && typeof nativeCount === 'number') {
                    return nativeCount;
                }
            } catch (err) {
                // Silently swallow and fallback
            }
        }

        // 2. tiktoken
        let textTokens = 0;
        try {
            const isO200k = typeof requestedModel === 'string' && (requestedModel.includes('gpt-4o') || requestedModel.includes('o1'));
            const encoding = isO200k ? this.o200k : this.cl100k;
            textTokens = encoding.encode(text).length;
        } catch (e) {
            // Silently swallow and fallback to character heuristic
            textTokens = Math.ceil(text.length * this.fallbackRatio);
        }

        return textTokens + imageCost;
    }
}
