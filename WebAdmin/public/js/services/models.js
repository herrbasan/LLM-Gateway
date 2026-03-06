// ============================================
// Models Service - Manages provider models
// ============================================

class ModelsService {
    constructor() {
        this.models = [];
        this.providers = [];
        this.modelsByProvider = new Map();
        this.listeners = new Set();
        this.lastFetch = 0;
        this.cacheTTL = 30000; // 30 seconds cache
    }

    subscribe(callback) {
        this.listeners.add(callback);
        // Immediately call with current data
        callback(this.getState());
        return () => this.listeners.delete(callback);
    }

    notify() {
        const state = this.getState();
        this.listeners.forEach(cb => cb(state));
    }

    getState() {
        return {
            models: this.models,
            providers: this.providers,
            modelsByProvider: Object.fromEntries(this.modelsByProvider)
        };
    }

    inferCapabilities(model) {
        const id = String(model?.id || '').toLowerCase();
        const existing = model?.capabilities || {};

        const embeddingPatterns = ['embed', 'embedding'];
        const imagePatterns = ['dall-e', 'imagen', 'imagine', 'image', 'veo', 'easel'];
        const ttsPatterns = ['tts', 'text-to-speech', 'speech'];
        const sttPatterns = ['stt', 'whisper', 'asr', 'transcribe', 'speech-to-text'];

        const inferredEmbeddings = embeddingPatterns.some(p => id.includes(p));
        const inferredImage = imagePatterns.some(p => id.includes(p));
        const inferredTts = ttsPatterns.some(p => id.includes(p));
        const inferredStt = sttPatterns.some(p => id.includes(p));

        const merged = { ...existing };

        // Only infer capabilities if API didn't provide them
        if (merged.embeddings === undefined) merged.embeddings = inferredEmbeddings;
        if (merged.imageGeneration === undefined) merged.imageGeneration = inferredImage;
        if (merged.tts === undefined) merged.tts = inferredTts;
        if (merged.stt === undefined) merged.stt = inferredStt;
        // Note: vision capability is now properly set by adapters, don't infer here

        if (merged.chat === undefined) {
            merged.chat = !merged.embeddings && !merged.imageGeneration && !merged.tts && !merged.stt;
        }

        return merged;
    }

    async fetchAllModels() {
        // Check cache - don't refetch if recent
        const now = Date.now();
        if (this.models.length > 0 && (now - this.lastFetch) < this.cacheTTL) {
            console.log('[ModelsService] Using cached models');
            return;
        }
        
        try {
            console.log('[ModelsService] Fetching models from gateway...');
            const gatewayUrl = window.location.origin.replace(':3401', ':3400');
            const response = await fetch(`${gatewayUrl}/v1/models`);
            const data = await response.json();
            console.log('[ModelsService] /v1/models response:', data);
            this.lastFetch = Date.now();
            
            const rawModels = data.data || [];
            this.models = rawModels.map(model => ({
                ...model,
                capabilities: this.inferCapabilities(model)
            }));
            
            // Build provider list and group models by provider
            const providerSet = new Set();
            this.modelsByProvider.clear();
            
            for (const model of this.models) {
                // Use explicit provider field from API - no more fragile ID parsing!
                const provider = model.provider || model.owned_by || 'unknown';
                
                providerSet.add(provider);
                
                if (!this.modelsByProvider.has(provider)) {
                    this.modelsByProvider.set(provider, []);
                }
                this.modelsByProvider.get(provider).push(model);
            }
            
            this.providers = Array.from(providerSet).sort();
            this.notify();
            
        } catch (error) {
            console.error('[ModelsService] Failed to fetch models:', error);
        }
    }

    getModelsForProvider(provider) {
        return this.modelsByProvider.get(provider) || [];
    }

    getAllProviders() {
        return this.providers;
    }

    getAllModels() {
        return this.models;
    }
}

// Singleton instance
export const modelsService = new ModelsService();
