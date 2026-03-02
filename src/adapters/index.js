import { createLmStudioAdapter } from './lmstudio.js';
import { createOllamaAdapter } from './ollama.js';
import { createGeminiAdapter } from './gemini.js';
import { createOpenAIAdapter } from './openai.js';
import { createKimiCliAdapter } from './kimi-cli.js';
import { createMiniMaxAdapter } from './minimax.js';
import { CircuitBreaker } from '../core/circuit-breaker.js';

function wrapWithCircuitBreaker(providerName, adapter) {
    const breaker = new CircuitBreaker(providerName);
    
    // We attach the breaker to the adapter so we can read metrics later on via /health
    adapter.circuitBreaker = breaker;

    const wrappedAdapter = Object.create(adapter);

    const methodsToWrap = ['predict', 'embedText', 'listModels', 'resolveModel'];
    const streamMethodsToWrap = ['streamComplete'];

    for (const method of methodsToWrap) {
        if (typeof adapter[method] === 'function') {
            wrappedAdapter[method] = (...args) => breaker.fire(() => adapter[method].apply(adapter, args));
        }
    }

    for (const method of streamMethodsToWrap) {
        if (typeof adapter[method] === 'function') {
            wrappedAdapter[method] = (...args) => breaker.fireStream(() => adapter[method].apply(adapter, args));
        }
    }

    return wrappedAdapter;
}

export function createAdapters(configProviders) {
    const registry = new Map();

    const factories = {
        lmstudio: createLmStudioAdapter,
        ollama: createOllamaAdapter,
        gemini: createGeminiAdapter,
        openai: createOpenAIAdapter,
        'kimi-cli': createKimiCliAdapter,
        minimax: createMiniMaxAdapter
    };

    for (const [providerName, providerConfig] of Object.entries(configProviders)) {
        if (!providerConfig || !providerConfig.type) {
            console.warn(`[Adapters] Skipping ${providerName} - Missing 'type' configuration.`);
            continue;
        }

        const factory = factories[providerConfig.type];
        if (!factory) {
             console.warn(`[Adapters] Skipping ${providerName} - Unknown provider type: ${providerConfig.type}`);
             continue;
        }

        const rawAdapter = factory({ ...providerConfig, providerName });
        const resilientAdapter = wrapWithCircuitBreaker(providerName, rawAdapter);
        registry.set(providerName, resilientAdapter);
    }

    return registry;
}
