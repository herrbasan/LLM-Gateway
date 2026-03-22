/**
 * Model Registry - Loads and validates model configuration.
 * Stateless, immutable, fails fast on invalid config.
 */

import { validateConfig, resolveConfigEnvVars } from './config-schema.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export class ModelRegistry {
    constructor(rawConfig) {
        if (!rawConfig) {
            throw new Error('[ModelRegistry] Config is required');
        }

        // Resolve environment variables first
        const resolvedConfig = resolveConfigEnvVars(rawConfig);
        
        // Validate - throws on invalid config
        validateConfig(resolvedConfig);

        // Build immutable model map
        this.models = new Map();
        for (const [modelId, modelConfig] of Object.entries(resolvedConfig.models)) {
            // Freeze each model config to prevent mutations
            this.models.set(modelId, Object.freeze({ ...modelConfig }));
        }

        // Global config
        this.globalConfig = Object.freeze({
            thinking: resolvedConfig.thinking || { enabled: false },
            compaction: resolvedConfig.compaction || { enabled: false },
            routing: resolvedConfig.routing || {}
        });

        logger.info('Initialized', { 
            modelCount: this.models.size,
            models: Array.from(this.models.keys())
        }, 'ModelRegistry');
    }

    /**
     * Get a model by ID. Throws if not found.
     */
    get(modelId) {
        const model = this.models.get(modelId);
        if (!model) {
            const err = new Error(`[ModelRegistry] Unknown model: "${modelId}"`);
            err.status = 404;
            throw err;
        }
        return model;
    }

    /**
     * Check if a model exists.
     */
    has(modelId) {
        return this.models.has(modelId);
    }

    /**
     * Get all model IDs.
     */
    getModelIds() {
        return Array.from(this.models.keys());
    }

    /**
     * Get all models of a specific type.
     */
    getByType(type) {
        const result = [];
        for (const [id, config] of this.models.entries()) {
            if (config.type === type) {
                result.push({ id, ...config });
            }
        }
        return result;
    }

    /**
     * Get all models for a specific adapter.
     */
    getByAdapter(adapterType) {
        const result = [];
        for (const [id, config] of this.models.entries()) {
            if (config.adapter === adapterType) {
                result.push({ id, ...config });
            }
        }
        return result;
    }

    /**
     * Resolve model ID, falling back to default if not specified.
     * Throws if resolved model doesn't exist or is wrong type.
     */
    resolveModel(modelId, expectedType) {
        const resolvedId = modelId || this.globalConfig.routing[`default${this._capitalize(expectedType)}Model`];
        
        if (!resolvedId) {
            const err = new Error(`[ModelRegistry] No model specified and no default ${expectedType} model configured`);
            err.status = 400;
            throw err;
        }

        const model = this.get(resolvedId);

        if (model.type !== expectedType) {
            const err = new Error(`[ModelRegistry] Model "${resolvedId}" is type "${model.type}", expected "${expectedType}"`);
            err.status = 400;
            throw err;
        }

        return { id: resolvedId, config: model };
    }

    /**
     * Get OpenAI-compatible model list.
     * @param {string} [type] - Optional filter by model type (chat, embedding, image, audio, video)
     * @param {boolean} [includeDisabled=false] - If true, include disabled models
     */
    listModels(type, includeDisabled = false) {
        const data = [];
        for (const [id, config] of this.models.entries()) {
            // Skip disabled models unless explicitly included
            if (!includeDisabled && config.disabled) {
                continue;
            }
            if (type && config.type !== type) {
                continue;
            }
            data.push({
                id,
                object: 'model',
                owned_by: config.adapter,
                type: config.type,
                capabilities: { ...config.capabilities }
            });
        }
        return { object: 'list', data };
    }

    /**
     * Get models grouped by type.
     * Returns an object with keys for each model type.
     * @param {boolean} [includeDisabled=false] - If true, include disabled models
     */
    listModelsByType(includeDisabled = false) {
        const result = {
            chat: [],
            embedding: [],
            image: [],
            audio: [],
            video: []
        };

        for (const [id, config] of this.models.entries()) {
            // Skip disabled models unless explicitly included
            if (!includeDisabled && config.disabled) {
                continue;
            }
            const modelInfo = {
                id,
                object: 'model',
                owned_by: config.adapter,
                capabilities: { ...config.capabilities }
            };

            if (result[config.type]) {
                result[config.type].push(modelInfo);
            }
        }

        return result;
    }

    /**
     * Get all model configs including disabled status.
     * Used by admin interfaces to show/edit all models.
     */
    getAllModelConfigs() {
        const result = {};
        for (const [id, config] of this.models.entries()) {
            result[id] = { ...config };
        }
        return result;
    }

    /**
     * Get global thinking configuration.
     */
    getThinkingConfig() {
        return this.globalConfig.thinking;
    }

    /**
     * Get global compaction configuration.
     */
    getCompactionConfig() {
        return this.globalConfig.compaction;
    }

    /**
     * Get global routing configuration.
     */
    getRoutingConfig() {
        return this.globalConfig.routing;
    }

    _capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }
}
