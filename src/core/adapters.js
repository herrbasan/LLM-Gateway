/**
 * Adapter factory - Creates protocol handlers without provider-level config.
 * Adapters are pure protocol handlers - stateless and config-agnostic.
 */

import { createGeminiAdapter } from '../adapters/gemini.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { createOllamaAdapter } from '../adapters/ollama.js';
import { createLmStudioAdapter } from '../adapters/lmstudio.js';
import { createKimiCliAdapter } from '../adapters/kimi-cli.js';
import { createKimiAdapter } from '../adapters/kimi.js';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createDashScopeAdapter } from '../adapters/dashscope.js';
import { createAlibabaAdapter } from '../adapters/alibaba.js';
import { CircuitBreaker } from './circuit-breaker.js';

const ADAPTER_FACTORIES = {
    gemini: createGeminiAdapter,
    openai: createOpenAIAdapter,
    ollama: createOllamaAdapter,
    lmstudio: createLmStudioAdapter,
    'kimi-cli': createKimiCliAdapter,
    kimi: createKimiAdapter,
    anthropic: createAnthropicAdapter,
    dashscope: createDashScopeAdapter,
    alibaba: createAlibabaAdapter
};

/**
 * Creates circuit-breaker wrapped adapters.
 * Adapters are stateless - model config is passed per-request.
 */
export function createAdapters() {
    const registry = new Map();

    for (const [type, factory] of Object.entries(ADAPTER_FACTORIES)) {
        // Create adapter - no config needed at factory time
        const adapter = factory();
        
        // Wrap with circuit breaker
        const wrapped = wrapWithCircuitBreaker(type, adapter);
        
        registry.set(type, wrapped);
    }

    return registry;
}

function wrapWithCircuitBreaker(adapterType, adapter) {
    const breaker = new CircuitBreaker(adapterType);

    // Methods to wrap with circuit breaker
    const methodsToWrap = [
        'chatComplete',
        'createEmbedding', 
        'generateImage',
        'synthesizeSpeech',
        'listModels'
    ];

    const streamMethodsToWrap = ['streamComplete'];

    const wrapped = Object.create(adapter);

    // Attach breaker for metrics
    wrapped.circuitBreaker = breaker;

    for (const method of methodsToWrap) {
        if (typeof adapter[method] === 'function') {
            wrapped[method] = (modelConfig, ...args) => 
                breaker.fire(() => adapter[method].call(adapter, modelConfig, ...args));
        }
    }

    for (const method of streamMethodsToWrap) {
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
