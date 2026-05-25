/**
 * Adapter factory - Creates protocol handlers without provider-level config.
 * Adapters are pure protocol handlers - stateless and config-agnostic.
 */

import { createGeminiAdapter } from '../adapters/gemini.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { createOllamaAdapter } from '../adapters/ollama.js';
import { createLmStudioAdapter } from '../adapters/lmstudio.js';
import { createKimiCliAdapter } from '../adapters/kimi-cli.js';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createDashScopeAdapter } from '../adapters/dashscope.js';
import { createAlibabaAdapter } from '../adapters/alibaba.js';
import { createResponsesAdapter } from '../adapters/responses.js';
import { createLlamaCppAdapter } from '../adapters/llamacpp.js';
import { CircuitBreaker } from './circuit-breaker.js';

const ADAPTER_FACTORIES = {
    gemini: createGeminiAdapter,
    openai: createOpenAIAdapter,
    ollama: createOllamaAdapter,
    lmstudio: createLmStudioAdapter,
    'kimi-cli': createKimiCliAdapter,
    anthropic: createAnthropicAdapter,
    dashscope: createDashScopeAdapter,
    alibaba: createAlibabaAdapter,
    responses: createResponsesAdapter,
    llamacpp: createLlamaCppAdapter
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
    const breakers = {
        chat: new CircuitBreaker(`${adapterType}:chat`, BREAKER_DEFAULTS.chat.threshold, BREAKER_DEFAULTS.chat.resetTimeoutMs),
        stream: new CircuitBreaker(`${adapterType}:stream`, BREAKER_DEFAULTS.stream.threshold, BREAKER_DEFAULTS.stream.resetTimeoutMs),
        embed: new CircuitBreaker(`${adapterType}:embed`, BREAKER_DEFAULTS.embed.threshold, BREAKER_DEFAULTS.embed.resetTimeoutMs),
        image: new CircuitBreaker(`${adapterType}:image`, BREAKER_DEFAULTS.image.threshold, BREAKER_DEFAULTS.image.resetTimeoutMs),
        audio: new CircuitBreaker(`${adapterType}:audio`, BREAKER_DEFAULTS.audio.threshold, BREAKER_DEFAULTS.audio.resetTimeoutMs),
        list: new CircuitBreaker(`${adapterType}:list`, BREAKER_DEFAULTS.list.threshold, BREAKER_DEFAULTS.list.resetTimeoutMs)
    };

    const methodMap = {
        chatComplete: breakers.chat,
        createEmbedding: breakers.embed,
        generateImage: breakers.image,
        synthesizeSpeech: breakers.audio,
        listModels: breakers.list
    };

    const streamMethodMap = {
        streamComplete: breakers.stream
    };

    const wrapped = Object.create(adapter);

    wrapped.circuitBreakers = breakers;

    for (const [method, breaker] of Object.entries(methodMap)) {
        if (typeof adapter[method] === 'function') {
            wrapped[method] = (modelConfig, ...args) =>
                breaker.fire(() => adapter[method].call(adapter, modelConfig, ...args));
        }
    }

    for (const [method, breaker] of Object.entries(streamMethodMap)) {
        if (typeof adapter[method] === 'function') {
            wrapped[method] = (modelConfig, ...args) =>
                breaker.fireStream(() => adapter[method].call(adapter, modelConfig, ...args));
        }
    }

    return wrapped;
}

/**
 * Get available adapter types.
 */
export function getAdapterTypes() {
    return Object.keys(ADAPTER_FACTORIES);
}
