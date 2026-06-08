/**
 * Model Registry - Loads and validates model configuration.
 * Stateless, immutable, fails fast on invalid config.
 */

import { validateConfig, resolveConfigEnvVars } from './config-schema.js';
import { TaskRegistry } from './task-registry.js';
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
            if (modelId.startsWith('_comment')) continue;
            // Freeze each model config to prevent mutations
            this.models.set(modelId, Object.freeze({ ...modelConfig }));
        }

        // Global config
        this.globalConfig = Object.freeze({
            thinking: resolvedConfig.thinking || { enabled: false }
        });

        // Task registry
        this.taskRegistry = new TaskRegistry(resolvedConfig.tasks || {});

        logger.info('Initialized', {
            modelCount: this.models.size,
            models: Array.from(this.models.keys()),
            taskCount: this.taskRegistry.getAll() ? Object.keys(this.taskRegistry.getAll()).length : 0
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
     * Resolve model ID. Throws if model doesn't exist or is wrong type.
     * No default fallback — the caller (ModelRouter) handles default task resolution.
     */
    resolveModel(modelId, expectedType) {
        if (!modelId) {
            const err = new Error(`[ModelRegistry] No model specified and no default task configured for type "${expectedType}"`);
            err.status = 400;
            throw err;
        }

        const model = this.get(modelId);

        if (model.disabled) {
            const err = new Error(`[ModelRegistry] Model "${modelId}" is disabled`);
            err.status = 403;
            throw err;
        }

        if (model.type !== expectedType) {
            const err = new Error(`[ModelRegistry] Model "${modelId}" is type "${model.type}", expected "${expectedType}"`);
            err.status = 400;
            throw err;
        }

        return { id: modelId, config: model };
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
            const contextWindow = config.capabilities?.contextWindow;
            const maxOutput = config.capabilities?.maxOutputTokens;
            data.push({
                id,
                object: 'model',
                owned_by: config.adapter,
                type: config.type,
                // Standard OpenAI-compatible fields
                context_length: contextWindow,
                max_output_tokens: maxOutput,
                // VS Code Copilot BYOK reads maxInputTokens for context window display
                maxInputTokens: contextWindow,
                // Backward compat: chat app may read top-level contextWindow
                contextWindow,
                maxOutputTokens: maxOutput,
                limit: contextWindow ? { context: contextWindow, output: maxOutput } : undefined,
                capabilities: {
                        ...config.capabilities,
                        ...(config.imageInputLimit && { imageInputLimit: config.imageInputLimit })
                    }
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
            const contextWindow = config.capabilities?.contextWindow;
            const maxOutput = config.capabilities?.maxOutputTokens;
            const modelInfo = {
                id,
                object: 'model',
                owned_by: config.adapter,
                context_length: contextWindow,
                max_output_tokens: maxOutput,
                maxInputTokens: contextWindow,
                contextWindow,
                maxOutputTokens: maxOutput,
                limit: contextWindow ? { context: contextWindow, output: maxOutput } : undefined,
                capabilities: {
                        ...config.capabilities,
                        ...(config.imageInputLimit && { imageInputLimit: config.imageInputLimit })
                    }
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
     * Get the task registry.
     */
    getTaskRegistry() {
        return this.taskRegistry;
    }

    /**
     * Get models by capability.
     * @param {string} capability - Capability name (e.g., 'vision', 'streaming')
     * @param {boolean} [includeDisabled=false] - If true, include disabled models
     * @returns {Array} Models that have the specified capability set to true
     */
    getByCapability(capability, includeDisabled = false) {
        const result = [];
        for (const [id, config] of this.models.entries()) {
            if (!includeDisabled && config.disabled) {
                continue;
            }
            if (config.capabilities && config.capabilities[capability] === true) {
                result.push({
                    id,
                    object: 'model',
                    owned_by: config.adapter,
                    type: config.type,
                    capabilities: {
                        ...config.capabilities,
                        ...(config.imageInputLimit && { imageInputLimit: config.imageInputLimit })
                    }
                });
            }
        }
        return result;
    }
}
