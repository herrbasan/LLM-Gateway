/**
 * Base adapter interface for model-centric architecture.
 * Adapters are pure protocol handlers - stateless and config-agnostic.
 */

/**
 * Creates a base adapter with the required interface.
 * All methods receive modelConfig as the first parameter.
 */
export function createBaseAdapter() {
    return {
        /**
         * Chat completion.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Standardized request with messages, max_tokens, etc.
         */
        async chatComplete(modelConfig, request) {
            throw new Error('[BaseAdapter] chatComplete not implemented');
        },

        /**
         * Streaming chat completion.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Standardized request
         */
        async *streamComplete(modelConfig, request) {
            throw new Error('[BaseAdapter] streamComplete not implemented');
        },

        /**
         * Create embeddings.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Request with input (string or array)
         */
        async createEmbedding(modelConfig, request) {
            throw new Error('[BaseAdapter] createEmbedding not implemented');
        },

        /**
         * Generate image.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Request with prompt, size, etc.
         */
        async generateImage(modelConfig, request) {
            throw new Error('[BaseAdapter] generateImage not implemented');
        },

        /**
         * Synthesize speech.
         * @param {Object} modelConfig - Model configuration from registry
         * @param {Object} request - Request with input, voice, etc.
         */
        async synthesizeSpeech(modelConfig, request) {
            throw new Error('[BaseAdapter] synthesizeSpeech not implemented');
        },

        /**
         * List available models.
         * @param {Object} modelConfig - Model configuration (for API key/endpoint if needed)
         */
        async listModels(modelConfig) {
            throw new Error('[BaseAdapter] listModels not implemented');
        }
    };
}
