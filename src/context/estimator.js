export class TokenEstimator {
    constructor(config) {
        this.fallbackRatio = config?.tokenEstimation?.fallbackRatio || 0.25;
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

        // 2. Character heuristic
        return Math.ceil(text.length * this.fallbackRatio);
    }
}
