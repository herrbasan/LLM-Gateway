// Base Adapter Structure that defines the contract all adapters must follow.

export function createBaseAdapter(name, adapterConfig, capabilities) {
    const defaultCapabilities = {
        embeddings: false,
        structuredOutput: false,
        streaming: false,
        vision: false,
        ...capabilities,
    };

    return {
        name,
        capabilities: defaultCapabilities,

        async resolveModel(requestedModel) {
            throw new Error(`[${name}] resolveModel not implemented`);
        },

        async predict({ prompt, systemPrompt, maxTokens, temperature, schema, messages }) {
            throw new Error(`[${name}] predict not implemented`);
        },

        async *streamComplete({ prompt, systemPrompt, maxTokens, temperature, schema, messages }) {
            throw new Error(`[${name}] streamComplete not implemented`);
        },

        async embedText(text, requestedModel) {
            throw new Error(`[${name}] embedText not implemented`);
        },

        async listModels() {
            throw new Error(`[${name}] listModels not implemented`);
        },

        async getContextWindow() {
            return adapterConfig.contextWindow || 8192; // Default fallback context window limit
        }
    };
}
