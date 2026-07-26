/**
 * Adapter factory - Creates protocol handlers without provider-level config.
 * Adapters are pure protocol handlers - stateless and config-agnostic.
 */

import { createGeminiAdapter } from '../adapters/gemini.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createResponsesAdapter } from '../adapters/responses.js';
import { CircuitBreaker } from './circuit-breaker.js';

const ADAPTER_FACTORIES = {
    gemini: createGeminiAdapter,
    openai: createOpenAIAdapter,
    anthropic: createAnthropicAdapter,
    responses: createResponsesAdapter
};

/**
 * Default circuit breaker configs per workload type.
 * Embedding workloads are more lenient because:
 * - Large batch operations have higher absolute failure counts at low percentages
 * - 500s from downstream servers are not tripped (connection failures only)
 */
const BREAKER_DEFAULTS = {
    chat: { threshold: 3, resetTimeoutMs: 30000 },
    stream: { threshold: 3, resetTimeoutMs: 30000 },
    embed: { threshold: 10, resetTimeoutMs: 60000 },
    image: { threshold: 5, resetTimeoutMs: 30000 },
    audio: { threshold: 5, resetTimeoutMs: 30000 },
    list: { threshold: 5, resetTimeoutMs: 30000 }
};

/**
 * Creates circuit-breaker wrapped adapters.
 * Adapters are stateless - model config is passed per-request.
 */
export function createAdapters() {
    const registry = new Map();

    for (const [type, factory] of Object.entries(ADAPTER_FACTORIES)) {
        const adapter = factory();
        const wrapped = wrapWithCircuitBreaker(type, adapter);
        registry.set(type, wrapped);
    }

    return registry;
}

function wrapWithCircuitBreaker(adapterType, adapter) {
    // Per-model breakers, lazily created: `${modelId}:${workload}`.
    // Sharing one breaker across all models on an adapter meant one flaky
    // upstream fast-failed every other model using that adapter protocol.
    const breakerMap = new Map();

    const getBreaker = (workload, modelKey) => {
        const key = `${modelKey}:${workload}`;
        let b = breakerMap.get(key);
        if (!b) {
            const d = BREAKER_DEFAULTS[workload];
            b = new CircuitBreaker(key, d.threshold, d.resetTimeoutMs);
            breakerMap.set(key, b);
        }
        return b;
    };

    // Stable per-request model key. The router stamps request.__modelId;
    // fall back to adapterModel, then 'unknown' for direct/test callers.
    const modelKeyOf = (modelConfig, request) =>
        (request && request.__modelId) || modelConfig?.adapterModel || 'unknown';

    const wrapped = Object.create(adapter);

    // Expose a live view for /health. Iterated fresh each call so per-model
    // breakers created after startup appear.
    Object.defineProperty(wrapped, 'circuitBreakers', {
        get() {
            const out = {};
            for (const [key, breaker] of breakerMap.entries()) {
                out[key] = breaker;
            }
            return out;
        }
    });

    const methodWorkload = {
        chatComplete: 'chat',
        createEmbedding: 'embed',
        generateImage: 'image',
        synthesizeSpeech: 'audio',
        listModels: 'list'
    };

    for (const [method, workload] of Object.entries(methodWorkload)) {
        if (typeof adapter[method] === 'function') {
            wrapped[method] = (modelConfig, ...args) =>
                getBreaker(workload, modelKeyOf(modelConfig, args[0]))
                    .fire(() => adapter[method].call(adapter, modelConfig, ...args));
        }
    }

    if (typeof adapter.streamComplete === 'function') {
        wrapped.streamComplete = (modelConfig, ...args) =>
            getBreaker('stream', modelKeyOf(modelConfig, args[0]))
                .fireStream(() => adapter.streamComplete.call(adapter, modelConfig, ...args));
    }

    return wrapped;
}

/**
 * Get available adapter types.
 */
export function getAdapterTypes() {
    return Object.keys(ADAPTER_FACTORIES);
}
