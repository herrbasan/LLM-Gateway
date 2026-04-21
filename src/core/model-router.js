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

        logger.info('Initialized', {
            models: this.registry.getModelIds().length,
            adapters: Array.from(this.adapters.keys()),
            mediaProcessor: this.mediaProcessor.isEnabled ? 'enabled' : 'disabled'
        }, 'ModelRouter');
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
        
        logger.info('Configuration reloaded', {
            models: this.registry.getModelIds().length,
            adapters: Array.from(this.adapters.keys()),
            mediaProcessor: this.mediaProcessor.isEnabled ? 'enabled' : 'disabled'
        }, 'ModelRouter');
    }

    /**
     * Route a chat completion request.
     */
    async routeChatCompletion(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('[ModelRouter] Request must be an object');
        }

        // Resolve task defaults if task is specified
        const taskRegistry = this.registry.getTaskRegistry();
        const { resolvedRequest, taskInfo } = taskRegistry.resolveChatRequest(request);
        const effectiveRequest = resolvedRequest;

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(effectiveRequest.model, 'chat');
        const adapter = this._getAdapter(modelConfig.adapter);

        logger.info('Routing chat completion', {
            model: modelId,
            adapter: modelConfig.adapter,
            task: taskInfo?.id || null
        }, 'ModelRouter');

        // Transform request to adapter format
        const opts = this._buildChatOptions(effectiveRequest, modelConfig);
        const sanitizedMessages = this._sanitizeIncomingMessages(opts.messages);

        // Process images only if requested (fetch remote URLs and resize/transcode)
        const processedMessages = await this._processImagesInMessages(
            sanitizedMessages,
            modelConfig,
            effectiveRequest.image_processing
        );

        // Apply context compaction if needed
        const { messages, context } = await this._handleContextCompaction(
            processedMessages,
            modelConfig,
            adapter
        );

        const resolvedMaxTokens = this._resolveChatMaxTokens(effectiveRequest, modelConfig, context);
        const responseContext = this._annotateContext(context, resolvedMaxTokens, effectiveRequest);

        const finalOpts = {
            ...opts,
            messages,
            maxTokens: resolvedMaxTokens,
            sessionId: effectiveRequest.sessionId || effectiveRequest.session_id || null
        };

        logger.info('Chat request prepared', {
            model: modelId,
            adapter: modelConfig.adapter,
            stream: effectiveRequest.stream === true,
            message_count: messages.length,
            context: responseContext,
            explicit_max_tokens: (effectiveRequest.max_completion_tokens ?? effectiveRequest.max_tokens ?? effectiveRequest.maxTokens) ?? null,
            resolved_max_tokens: resolvedMaxTokens,
            temperature: finalOpts.temperature ?? null,
            task: taskInfo?.id || null
        }, 'ModelRouter');

        // Route to adapter
        let result;
        if (effectiveRequest.stream) {
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
        const clientStrip = effectiveRequest.strip_thinking === true || effectiveRequest.no_thinking === true;
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
     * Route an incoming Responses API request to the appropriate adapter.
     * Currently re-uses routeChatCompletion internals since our responses adapter
     * is just an alternative chat completions provider downstream.
     *
     * @param {Object} rawRequest - The incoming Responses API request payload
     * @returns {Object} Response object
     */
    async routeResponse(rawRequest) {
        if (!rawRequest || typeof rawRequest !== 'object') {
            throw new Error('[ModelRouter] Request must be an object');
        }

        const request = rawRequest.input && Array.isArray(rawRequest.input)
            ? { ...rawRequest, messages: rawRequest.input }
            : rawRequest;

        return this.routeChatCompletion(request);
    }

    /**
     * Route an embedding request.
     */
    async routeEmbedding(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('[ModelRouter] Request must be an object');
        }

        const taskRegistry = this.registry.getTaskRegistry();
        const { resolvedRequest, taskInfo } = taskRegistry.resolveGenericRequest(request);

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(resolvedRequest.model, 'embedding');
        const adapter = this._getAdapter(modelConfig.adapter);

        logger.info('Routing embedding', {
            model: modelId,
            adapter: modelConfig.adapter,
            task: taskInfo?.id || null
        }, 'ModelRouter');

        return adapter.createEmbedding(modelConfig, resolvedRequest);
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

        const taskRegistry = this.registry.getTaskRegistry();
        const { resolvedRequest, taskInfo } = taskRegistry.resolveGenericRequest(request);

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(resolvedRequest.model, 'image');
        const adapter = this._getAdapter(modelConfig.adapter);

        logger.info('Routing image generation', {
            model: modelId,
            adapter: modelConfig.adapter,
            task: taskInfo?.id || null
        }, 'ModelRouter');

        return adapter.generateImage(modelConfig, resolvedRequest);
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

        const taskRegistry = this.registry.getTaskRegistry();
        const { resolvedRequest, taskInfo } = taskRegistry.resolveGenericRequest(request);

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(resolvedRequest.model, 'audio');
        const adapter = this._getAdapter(modelConfig.adapter);

        logger.info('Routing audio speech', {
            model: modelId,
            adapter: modelConfig.adapter,
            task: taskInfo?.id || null
        }, 'ModelRouter');

        return adapter.synthesizeSpeech(modelConfig, resolvedRequest);
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

        logger.info('Routing video generation', { model: modelId, adapter: modelConfig.adapter }, 'ModelRouter');

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
            maxTokens: request.max_completion_tokens ?? request.max_tokens ?? request.maxTokens,
            maxCompletionTokens: request.max_completion_tokens,
            signal: request.signal,
            temperature: request.temperature,
            systemPrompt: request.systemPrompt,
            schema: request.response_format?.json_schema?.schema,
            // Extended OpenAI features
            tools: request.tools,
            tool_choice: request.tool_choice,
            parallel_tool_calls: request.parallel_tool_calls,
            functions: request.functions,
            function_call: request.function_call,
            response_format: request.response_format,
            stream_options: request.stream_options,
            stop: request.stop,
            seed: request.seed,
            frequency_penalty: request.frequency_penalty,
            presence_penalty: request.presence_penalty,
            logit_bias: request.logit_bias,
            logprobs: request.logprobs,
            top_logprobs: request.top_logprobs,
            user: request.user,
            n: request.n,
            top_p: request.top_p,
            extra_body: request.extra_body,
            enable_thinking: request.enable_thinking,
            chat_template_kwargs: request.chat_template_kwargs
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
        // Accept both snake_case (max_tokens) and camelCase (maxTokens) from clients
        const requestedMaxTokens = request.max_completion_tokens ?? request.max_tokens ?? request.maxTokens;
        if (requestedMaxTokens != null) {
            return requestedMaxTokens;
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
                max_tokens_source: (request.max_completion_tokens != null || request.max_tokens != null) ? 'explicit' : 'implicit'
            };
        }

        return {
            ...context,
            resolved_max_tokens: resolvedMaxTokens,
            max_tokens_source: (request.max_completion_tokens != null || request.max_tokens != null) ? 'explicit' : 'implicit'
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

        logger.debug('Context check', {
            estimated: estimatedTokens,
            window: contextWindow,
            available: availableTokens
        }, 'ModelRouter');

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

        logger.info('Applying compaction', { mode: compactionConfig.mode, tokens: estimatedTokens }, 'ModelRouter');

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

        logger.info('Compaction complete', {
            original: estimatedTokens,
            final: finalTokens,
            mode: compactionConfig.mode
        }, 'ModelRouter');

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
                logger.warn('Native message token count failed, falling back to estimator', {
                    adapter: modelConfig?.adapter,
                    model: modelConfig?.adapterModel,
                    error: err.message
                }, 'ModelRouter');
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
            logger.warn('Image processing requested but MediaService not enabled', {}, 'ModelRouter');
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
                        logger.warn('Large image processed', {
                            sizeMB: base64SizeMB.toFixed(2),
                            maxDimension: processOptions.maxDimension,
                            quality: processOptions.quality,
                            format: processOptions.format
                        }, 'ModelRouter');
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

                    logger.debug('Image processed', {
                        resize: processOptions.maxDimension,
                        format: processOptions.format,
                        quality: processOptions.quality
                    }, 'ModelRouter');
                } catch (error) {
                    logger.warn('Failed to process image, using original', {
                        error: error.message
                    }, 'ModelRouter');
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
            logger.info('Images processed', { count: processedCount }, 'ModelRouter');
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
                    logger.warn('Failed to fetch remote image, using original URL', {
                        error: error.message
                    }, 'ModelRouter');
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
