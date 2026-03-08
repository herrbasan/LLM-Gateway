/**
 * ModelRouter - Routes requests to appropriate adapters based on model-centric config.
 * Stateless, explicit, fails fast.
 */

import { ModelRegistry } from './model-registry.js';
import { createAdapters } from './adapters.js';
import { TokenEstimator } from '../context/estimator.js';
import { ContextManager } from '../context/strategy.js';
import { stripThinking } from '../utils/format.js';
import { getLogger } from '../utils/logger.js';
import { MediaProcessorClient } from '../utils/media-client.js';
import { imageFetcher } from '../utils/image-fetcher.js';

const logger = getLogger();

export class ModelRouter {
    constructor(config) {
        if (!config) {
            throw new Error('[ModelRouter] Config is required');
        }

        // Initialize registry (validates config)
        this.registry = new ModelRegistry(config);

        // Create adapters (simplified - no config needed at factory level)
        this.adapters = createAdapters();

        // Context management components
        this.tokenEstimator = new TokenEstimator(config);
        this.contextManager = new ContextManager(config);

        // Media processor for image optimization
        this.mediaProcessor = new MediaProcessorClient(config);

        logger.info('[ModelRouter] Initialized', {
            models: this.registry.getModelIds().length,
            adapters: Array.from(this.adapters.keys()),
            mediaProcessor: this.mediaProcessor.isEnabled ? 'enabled' : 'disabled'
        });
    }

    /**
     * Route a chat completion request.
     */
    async routeChatCompletion(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('[ModelRouter] Request must be an object');
        }

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(request.model, 'chat');
        const adapter = this._getAdapter(modelConfig.adapter);

        logger.info('[ModelRouter] Routing chat completion', { model: modelId, adapter: modelConfig.adapter });

        // Transform request to adapter format
        const opts = this._buildChatOptions(request);

        // Process images (fetch remote URLs and resize if needed)
        const processedMessages = await this._processImagesInMessages(
            opts.messages,
            modelConfig
        );

        // Apply context compaction if needed
        const { messages, context } = await this._handleContextCompaction(
            processedMessages,
            modelConfig,
            adapter
        );

        const finalOpts = { ...opts, messages };

        // Route to adapter
        let result;
        if (request.stream) {
            return {
                stream: true,
                generator: adapter.streamComplete(modelConfig, finalOpts),
                context
            };
        } else {
            result = await adapter.chatComplete(modelConfig, finalOpts);
            result.context = context;
        }

        // Apply thinking strip if configured
        const thinkingConfig = this.registry.getThinkingConfig();
        if (thinkingConfig.enabled && result.choices?.[0]?.message?.content) {
            result.choices[0].message.content = stripThinking(
                result.choices[0].message.content,
                thinkingConfig
            );
        }

        return result;
    }

    /**
     * Route an embedding request.
     */
    async routeEmbedding(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('[ModelRouter] Request must be an object');
        }

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(request.model, 'embedding');
        const adapter = this._getAdapter(modelConfig.adapter);

        logger.info('[ModelRouter] Routing embedding', { model: modelId, adapter: modelConfig.adapter });

        return adapter.createEmbedding(modelConfig, request);
    }

    /**
     * Route an image generation request.
     */
    async routeImageGeneration(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('[ModelRouter] Request must be an object');
        }

        if (!request.prompt) {
            const err = new Error('[ModelRouter] Missing required field: prompt');
            err.status = 400;
            throw err;
        }

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(request.model, 'image');
        const adapter = this._getAdapter(modelConfig.adapter);

        logger.info('[ModelRouter] Routing image generation', { model: modelId, adapter: modelConfig.adapter });

        return adapter.generateImage(modelConfig, request);
    }

    /**
     * Route an audio speech request.
     */
    async routeAudioSpeech(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('[ModelRouter] Request must be an object');
        }

        if (!request.input) {
            const err = new Error('[ModelRouter] Missing required field: input');
            err.status = 400;
            throw err;
        }

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(request.model, 'audio');
        const adapter = this._getAdapter(modelConfig.adapter);

        logger.info('[ModelRouter] Routing audio speech', { model: modelId, adapter: modelConfig.adapter });

        return adapter.synthesizeSpeech(modelConfig, request);
    }

    /**
     * List all available models.
     */
    async listModels() {
        return this.registry.listModels();
    }

    /**
     * Get adapter by type.
     */
    _getAdapter(adapterType) {
        const adapter = this.adapters.get(adapterType);
        if (!adapter) {
            throw new Error(`[ModelRouter] Unknown adapter: "${adapterType}"`);
        }
        return adapter;
    }

    /**
     * Build chat options from request.
     */
    _buildChatOptions(request) {
        return {
            messages: request.messages || [],
            maxTokens: request.max_tokens,
            temperature: request.temperature,
            systemPrompt: request.systemPrompt,
            schema: request.response_format?.json_schema?.schema
        };
    }

    /**
     * Handle context compaction if enabled and needed.
     */
    async _handleContextCompaction(messages, modelConfig, adapter) {
        const compactionConfig = this.registry.getCompactionConfig();

        if (!compactionConfig.enabled || messages.length === 0) {
            return { messages, context: null };
        }

        const estimatedTokens = await this._estimateMessagesTokens(messages, adapter, modelConfig);
        const contextWindow = modelConfig.capabilities.contextWindow;
        const outputBuffer = 1024; // Safe default
        const safetyMargin = Math.floor(contextWindow * 0.20);
        const availableTokens = contextWindow - outputBuffer - safetyMargin;

        logger.debug('[ModelRouter] Context check', {
            estimated: estimatedTokens,
            window: contextWindow,
            available: availableTokens
        });

        const minTokens = compactionConfig.minTokensToCompact || 2000;
        const shouldCompact = estimatedTokens >= minTokens && estimatedTokens > availableTokens;

        if (!shouldCompact) {
            return {
                messages,
                context: this._buildContextPayload(contextWindow, estimatedTokens, false)
            };
        }

        if (compactionConfig.mode === 'none') {
            const err = new Error(`[ModelRouter] Payload too large: ${estimatedTokens} tokens exceeds available ${availableTokens}`);
            err.status = 413;
            throw err;
        }

        logger.info('[ModelRouter] Applying compaction', { mode: compactionConfig.mode, tokens: estimatedTokens });

        const strategyFn = this.contextManager[compactionConfig.mode]?.bind(this.contextManager)
            || this.contextManager.truncate.bind(this.contextManager);

        const compactedMessages = await strategyFn(
            messages,
            availableTokens,
            this.tokenEstimator,
            adapter,
            compactionConfig
        );

        const finalTokens = await this._estimateMessagesTokens(compactedMessages, adapter, modelConfig);

        logger.info('[ModelRouter] Compaction complete', {
            original: estimatedTokens,
            final: finalTokens,
            mode: compactionConfig.mode
        });

        return {
            messages: compactedMessages,
            context: this._buildContextPayload(contextWindow, finalTokens, true)
        };
    }

    /**
     * Estimate tokens for messages.
     */
    async _estimateMessagesTokens(messages, adapter, modelConfig) {
        let total = 0;
        for (const m of messages) {
            if (Array.isArray(m.content)) {
                total += await this.tokenEstimator.estimate(m.content, adapter, modelConfig.adapterModel);
            } else {
                total += await this.tokenEstimator.estimate(String(m.content || ''), adapter, modelConfig.adapterModel);
            }
        }
        return total;
    }

    /**
     * Build context payload.
     */
    _buildContextPayload(contextWindow, usedTokens, strategyApplied) {
        return {
            window_size: contextWindow,
            used_tokens: usedTokens,
            available_tokens: Math.max(0, contextWindow - usedTokens),
            strategy_applied: strategyApplied
        };
    }

    /**
     * Process images in messages: fetch remote URLs and resize via MediaProcessor.
     */
    async _processImagesInMessages(messages, modelConfig) {
        if (!this.mediaProcessor.isEnabled) {
            return messages;
        }

        // Check if model supports vision
        if (!modelConfig.capabilities?.vision) {
            return messages;
        }

        const visionLimits = modelConfig.visionLimits;
        if (!visionLimits?.maxDimension) {
            logger.debug('[ModelRouter] No visionLimits configured, skipping image processing');
            return messages;
        }

        const processedMessages = [];
        let processedCount = 0;

        for (const message of messages) {
            if (!Array.isArray(message.content)) {
                processedMessages.push(message);
                continue;
            }

            const processedContent = [];

            for (const part of message.content) {
                if (part.type !== 'image_url') {
                    processedContent.push(part);
                    continue;
                }

                const imageUrl = part.image_url?.url || '';
                const detail = part.image_url?.detail || 'auto';

                try {
                    // Fetch image (handles both data URLs and remote URLs)
                    const { mimeType, base64 } = await imageFetcher.fetchImage(imageUrl);

                    // Determine max dimension based on detail level and model limits
                    let maxDimension = visionLimits.maxDimension;
                    if (detail === 'low') {
                        maxDimension = Math.min(512, visionLimits.maxDimension);
                    } else if (detail === 'auto') {
                        maxDimension = Math.min(1024, visionLimits.maxDimension);
                    }

                    // Optimize image via MediaProcessor
                    const optimizedBase64 = await this.mediaProcessor.optimizeImage(
                        base64,
                        mimeType,
                        detail,
                        modelConfig.adapter,
                        maxDimension
                    );

                    processedContent.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${mimeType};base64,${optimizedBase64}`,
                            detail
                        }
                    });
                    processedCount++;

                    logger.debug('[ModelRouter] Image processed', {
                        detail,
                        maxDimension,
                        adapter: modelConfig.adapter
                    });
                } catch (error) {
                    logger.warn('[ModelRouter] Failed to process image, using original', {
                        error: error.message
                    });
                    // Fall back to original
                    processedContent.push(part);
                }
            }

            processedMessages.push({
                ...message,
                content: processedContent
            });
        }

        if (processedCount > 0) {
            logger.info('[ModelRouter] Images processed', { count: processedCount });
        }

        return processedMessages;
    }
}
