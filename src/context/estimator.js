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
    async estimate(text, adapter, requestedModel) {
        if (!text) return 0;

        // 1. Try Provider Native
        if (adapter && typeof adapter.countTokens === 'function') {
            try {
                const nativeCount = await adapter.countTokens(text, requestedModel);
                if (nativeCount !== null && typeof nativeCount === 'number') {
                    return nativeCount;
                }
            } catch (err) {
                // Silently swallow and fallback
            }
        }

        // 2. tiktoken
        try {
            const isO200k = typeof requestedModel === 'string' && (requestedModel.includes('gpt-4o') || requestedModel.includes('o1'));
            const encoding = isO200k ? this.o200k : this.cl100k;
            return encoding.encode(text).length;
        } catch (e) {
            // Silently swallow
        }

        // 3. Character heuristic
        return Math.ceil(text.length * this.fallbackRatio);
    }
}
