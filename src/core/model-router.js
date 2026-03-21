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
     * Reload configuration dynamically without restarting the server.
     */
    reloadConfig(newConfig) {
        if (!newConfig) {
            throw new Error('[ModelRouter] Config is required for reload');
        }

        this.registry = new ModelRegistry(newConfig);
        this.tokenEstimator = new TokenEstimator(newConfig);
        this.contextManager = new ContextManager(newConfig);
        this.mediaProcessor = new MediaProcessorClient(newConfig);
        
        logger.info('[ModelRouter] Configuration reloaded', {
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
        const opts = this._buildChatOptions(request, modelConfig);
        const sanitizedMessages = this._sanitizeIncomingMessages(opts.messages);

        // Process images only if requested (fetch remote URLs and resize/transcode)
        const processedMessages = await this._processImagesInMessages(
            sanitizedMessages,
            modelConfig,
            request.image_processing  // { resize: 'auto'|'low'|'high'|number, transcode: 'jpg'|'png'|'webp' }
        );

        // Apply context compaction if needed
        const { messages, context } = await this._handleContextCompaction(
            processedMessages,
            modelConfig,
            adapter
        );

        const resolvedMaxTokens = this._resolveChatMaxTokens(request, modelConfig, context);
        const responseContext = this._annotateContext(context, resolvedMaxTokens, request);

        const finalOpts = {
            ...opts,
            messages,
            maxTokens: resolvedMaxTokens
        };

        logger.info('[ModelRouter] Chat request prepared', {
            model: modelId,
            adapter: modelConfig.adapter,
            stream: request.stream === true,
            message_count: messages.length,
            messages: this._summarizeMessagesForLog(messages),
            context: responseContext,
            explicit_max_tokens: request.max_tokens ?? null,
            resolved_max_tokens: resolvedMaxTokens,
            temperature: finalOpts.temperature ?? null
        });

        // Route to adapter
        let result;
        if (request.stream) {
            return {
                stream: true,
                generator: adapter.streamComplete(modelConfig, finalOpts),
                context: responseContext
            };
        } else {
            result = await adapter.chatComplete(modelConfig, finalOpts);
            result.context = responseContext;
        }

        // Apply thinking strip if configured or requested
        const globalThinkingConfig = this.registry.getThinkingConfig();
        const clientStrip = request.strip_thinking === true || request.no_thinking === true;
        const shouldStripThinking = clientStrip || globalThinkingConfig.enabled;

        if (shouldStripThinking && result.choices?.[0]?.message) {
            if (result.choices[0].message.content) {
                result.choices[0].message.content = stripThinking(
                    result.choices[0].message.content,
                    this._getThinkingStripConfig(globalThinkingConfig)
                );
            }
            if (result.choices[0].message.reasoning_content !== undefined) {
                delete result.choices[0].message.reasoning_content;
            }
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
     * Route a video generation request.
     */
    async routeVideoGeneration(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('[ModelRouter] Request must be an object');
        }

        if (!request.prompt) {
            const err = new Error('[ModelRouter] Missing required field: prompt');
            err.status = 400;
            throw err;
        }

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(request.model, 'video');
        const adapter = this._getAdapter(modelConfig.adapter);

        logger.info('[ModelRouter] Routing video generation', { model: modelId, adapter: modelConfig.adapter });

        return adapter.generateVideo(modelConfig, request);
    }

    /**
     * List all available models.
     * @param {string} [type] - Optional filter by model type
     */
    async listModels(type) {
        return this.registry.listModels(type);
    }

    /**
     * List models grouped by type.
     */
    async listModelsByType() {
        return this.registry.listModelsByType();
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
    _buildChatOptions(request, modelConfig) {
        return {
            messages: request.messages || [],
            maxTokens: request.max_tokens,
            signal: request.signal,
            temperature: request.temperature,
            systemPrompt: request.systemPrompt,
            schema: request.response_format?.json_schema?.schema
        };
    }

    /**
     * Remove prior assistant reasoning traces from incoming chat history.
     */
    _sanitizeIncomingMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return [];
        }

        const stripConfig = this._getThinkingStripConfig(this.registry.getThinkingConfig());

        return messages.reduce((acc, message) => {
            if (!message || typeof message !== 'object') {
                return acc;
            }

            if (message.role !== 'assistant') {
                acc.push(message);
                return acc;
            }

            const sanitizedMessage = this._sanitizeAssistantMessage(message, stripConfig);
            if (sanitizedMessage) {
                acc.push(sanitizedMessage);
            }
            return acc;
        }, []);
    }

    _sanitizeAssistantMessage(message, stripConfig) {
        if (typeof message.content === 'string') {
            const content = stripThinking(message.content, stripConfig);
            return content ? { ...message, content } : null;
        }

        if (Array.isArray(message.content)) {
            const content = message.content
                .map(part => {
                    if (part?.type !== 'text') {
                        return part;
                    }

                    const text = stripThinking(part.text || '', stripConfig);
                    return text ? { ...part, text } : null;
                })
                .filter(Boolean);

            return content.length > 0 ? { ...message, content } : null;
        }

        return message;
    }

    _getThinkingStripConfig(thinkingConfig = {}) {
        return {
            tags: thinkingConfig.stripTags || thinkingConfig.tags,
            orphanCloseAsSeparator: thinkingConfig.orphanCloseAsSeparator
        };
    }

    /**
     * Resolve the max output token budget for a chat request.
     */
    _resolveChatMaxTokens(request, modelConfig, context) {
        if (request.max_tokens != null) {
            return request.max_tokens;
        }

        const contextWindow = modelConfig?.capabilities?.contextWindow || 8192;
        const maxOutputTokens = modelConfig?.capabilities?.maxOutputTokens;
        const usedTokens = context?.used_tokens || 0;
        const safetyMargin = Math.floor(contextWindow * 0.20);
        let remainingBudget = contextWindow - usedTokens - safetyMargin;
        
        remainingBudget = Math.max(1, remainingBudget);

        if (maxOutputTokens && remainingBudget > maxOutputTokens) {
            return maxOutputTokens;
        }

        return remainingBudget;
    }

    /**
     * Attach resolved token budget metadata to response context.
     */
    _annotateContext(context, resolvedMaxTokens, request) {
        if (!context) {
            return {
                resolved_max_tokens: resolvedMaxTokens,
                max_tokens_source: request.max_tokens != null ? 'explicit' : 'implicit'
            };
        }

        return {
            ...context,
            resolved_max_tokens: resolvedMaxTokens,
            max_tokens_source: request.max_tokens != null ? 'explicit' : 'implicit'
        };
    }

    /**
     * Handle context compaction if enabled and needed.
     */
    async _handleContextCompaction(messages, modelConfig, adapter) {
        const compactionConfig = this.registry.getCompactionConfig() || {};

        if (messages.length === 0) {
            return { messages, context: null };
        }

        const estimatedTokens = await this._estimateMessagesTokens(messages, adapter, modelConfig);
        const contextWindow = modelConfig.capabilities?.contextWindow || 8192;
        const outputBuffer = 1024; // Safe default
        const safetyMargin = Math.floor(contextWindow * 0.20);
        const availableTokens = contextWindow - outputBuffer - safetyMargin;

        logger.debug('[ModelRouter] Context check', {
            estimated: estimatedTokens,
            window: contextWindow,
            available: availableTokens
        });

        const minTokens = compactionConfig.minTokensToCompact || 2000;
        const shouldCompact = compactionConfig.enabled !== false && estimatedTokens >= minTokens && estimatedTokens > availableTokens;

        if (!shouldCompact) {
            return {
                messages,
                context: {
                    window_size: contextWindow,
                    used_tokens: estimatedTokens,
                    available_tokens: Math.max(0, contextWindow - estimatedTokens),
                    strategy_applied: false
                }
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
        if (adapter && typeof adapter.countMessageTokens === 'function') {
            try {
                const nativeCount = await adapter.countMessageTokens(messages, modelConfig);
                if (typeof nativeCount === 'number' && Number.isFinite(nativeCount)) {
                    return nativeCount;
                }
            } catch (err) {
                logger.warn('[ModelRouter] Native message token count failed, falling back to estimator', {
                    adapter: modelConfig?.adapter,
                    model: modelConfig?.adapterModel,
                    error: err.message
                });
            }
        }

        let total = 3; // Base overhead for the request formatting
        for (const m of messages) {
            total += 4; // Base overhead for each message (role, formatting)
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

    _summarizeMessagesForLog(messages) {
        if (!Array.isArray(messages)) {
            return [];
        }

        return messages.map((message, index) => {
            if (typeof message?.content === 'string') {
                return {
                    index,
                    role: message.role,
                    chars: message.content.length,
                    preview: message.content.slice(0, 160)
                };
            }

            if (Array.isArray(message?.content)) {
                const text = message.content
                    .filter(part => part?.type === 'text')
                    .map(part => part.text || '')
                    .join('\n');

                return {
                    index,
                    role: message.role,
                    content_parts: message.content.length,
                    text_chars: text.length,
                    preview: text.slice(0, 160)
                };
            }

            return {
                index,
                role: message?.role,
                content_type: typeof message?.content
            };
        });
    }

    /**
     * Process images in messages: fetch remote URLs and optionally resize/transcode.
     * 
     * Image processing is OPT-IN via request.image_processing options:
     * - resize: 'auto' | 'low' | 'high' | number (max dimension in pixels)
     * - transcode: 'jpg' | 'jpeg' | 'png' | 'webp' (output format)
     * - quality: number (1-100, for lossy formats)
     * 
     * By default, only remote URLs are fetched (no resizing/transcoding).
     */
    async _processImagesInMessages(messages, modelConfig, imageProcessing = null) {
        const shouldResize = imageProcessing?.resize;
        const shouldTranscode = imageProcessing?.transcode;
        
        // If no processing requested and MediaService not enabled, just pass through
        if (!shouldResize && !shouldTranscode) {
            // Still fetch remote URLs even without processing
            return this._fetchRemoteImagesOnly(messages);
        }

        if (!this.mediaProcessor.isEnabled) {
            logger.warn('[ModelRouter] Image processing requested but MediaService not enabled');
            return this._fetchRemoteImagesOnly(messages);
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

                    // Determine processing options
                    const processOptions = this._resolveImageProcessingOptions(
                        imageProcessing,
                        detail,
                        modelConfig.imageInputLimit
                    );

                    // Process image via MediaProcessor
                    const processedBase64 = await this.mediaProcessor.processImage(
                        base64,
                        mimeType,
                        processOptions
                    );

                    // Log image size for debugging 413 errors
                    const base64SizeMB = (processedBase64.length * 3 / 4) / 1024 / 1024;
                    if (base64SizeMB > 5) {
                        logger.warn('[ModelRouter] Large image processed', {
                            sizeMB: base64SizeMB.toFixed(2),
                            maxDimension: processOptions.maxDimension,
                            quality: processOptions.quality,
                            format: processOptions.format
                        });
                    }

                    // Determine output mime type based on transcode option
                    let outputMimeType = mimeType;
                    if (processOptions.format) {
                        outputMimeType = `image/${processOptions.format === 'jpg' ? 'jpeg' : processOptions.format}`;
                    }

                    processedContent.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${outputMimeType};base64,${processedBase64}`,
                            detail
                        }
                    });
                    processedCount++;

                    logger.debug('[ModelRouter] Image processed', {
                        resize: processOptions.maxDimension,
                        format: processOptions.format,
                        quality: processOptions.quality
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

    /**
     * Fetch remote images without any processing.
     */
    async _fetchRemoteImagesOnly(messages) {
        const processedMessages = [];

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

                // Skip if already a data URL
                if (imageUrl.startsWith('data:')) {
                    processedContent.push(part);
                    continue;
                }

                try {
                    const { mimeType, base64 } = await imageFetcher.fetchImage(imageUrl);
                    processedContent.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${mimeType};base64,${base64}`,
                            detail: part.image_url?.detail || 'auto'
                        }
                    });
                } catch (error) {
                    logger.warn('[ModelRouter] Failed to fetch remote image, using original URL', {
                        error: error.message
                    });
                    processedContent.push(part);
                }
            }

            processedMessages.push({
                ...message,
                content: processedContent
            });
        }

        return processedMessages;
    }

    /**
     * Resolve image processing options from request and defaults.
     */
    _resolveImageProcessingOptions(imageProcessing, detail, imageInputLimit) {
        const options = {
            quality: imageProcessing?.quality || (detail === 'low' ? 70 : 85)
        };

        // Resolve resize option
        const resize = imageProcessing?.resize;
        if (typeof resize === 'number') {
            options.maxDimension = resize;
        } else if (resize === 'auto') {
            options.maxDimension = imageInputLimit?.maxDimension || 2048;
        } else if (resize === 'low') {
            options.maxDimension = 512;
        } else if (resize === 'high') {
            options.maxDimension = imageInputLimit?.maxDimension || 2048;
        }

        // Resolve transcode option
        const transcode = imageProcessing?.transcode;
        if (transcode) {
            options.format = transcode === 'jpg' ? 'jpeg' : transcode;
        } else if (resize) {
            // Default to jpeg if resizing but no explicit transcode
            options.format = 'jpeg';
        }

        return options;
    }
}
