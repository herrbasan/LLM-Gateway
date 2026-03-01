import { createLmStudioAdapter } from './lmstudio.js';
import { createOllamaAdapter } from './ollama.js';
import { createGeminiAdapter } from './gemini.js';
import { createOpenAIAdapter } from './openai.js';

export function createAdapters(configProviders) {
    const registry = new Map();

    const factories = {
        lmstudio: createLmStudioAdapter,
        ollama: createOllamaAdapter,
        gemini: createGeminiAdapter,
        openai: createOpenAIAdapter
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

        registry.set(providerName, factory(providerConfig));
    }

    return registry;
}
