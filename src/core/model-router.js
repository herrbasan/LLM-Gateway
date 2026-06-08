/**
 * ModelRouter - Routes requests to appropriate adapters based on model-centric config.
 * Stateless, explicit, fails fast.
 */

import { ModelRegistry } from './model-registry.js';
import { createAdapters } from './adapters.js';
import { TokenEstimator } from '../context/estimator.js';
import { FallbackTracker } from './fallback-tracker.js';
import { getLogger } from '../utils/logger.js';
import { MediaProcessorClient } from '../utils/media-client.js';
import { imageFetcher } from '../utils/image-fetcher.js';
import { chatCompletionsToResponse, convertStreamToResponseEvents } from '../utils/response-format.js';

const logger = getLogger();

function convertInputToMessages(input) {
    if (!Array.isArray(input)) return [{ role: 'user', content: String(input) }];

    return input.map(item => {
        if (typeof item === 'string') {
            return { role: 'user', content: item };
        }

        if (item.role === 'function_call_output' || item.type === 'function_call_output') {
            return {
                role: 'tool',
                tool_call_id: item.call_id || item.id,
                content: item.output || item.content || ''
            };
        }

        if (item.type === 'function_call') {
            return {
                role: 'assistant',
                tool_calls: [{
                    id: item.call_id || item.id,
                    type: 'function',
                    function: { name: item.name, arguments: item.arguments || '{}' }
                }],
                content: null
            };
        }

        if (Array.isArray(item.content)) {
            const content = item.content.map(part => {
                if (part.type === 'input_text') return { type: 'text', text: part.text };
                if (part.type === 'input_image') return { type: 'image_url', image_url: { url: part.image_url } };
                return part;
            });
            return { role: item.role || 'user', content };
        }

        return { role: item.role || 'user', content: item.content || '' };
    });
}

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

        // Media processor for image optimization
        this.mediaProcessor = new MediaProcessorClient(config);

        // Fallback tracker for task model failures
        this.fallbackTracker = new FallbackTracker();

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
        const { resolvedRequest, taskInfo } = this._resolveRequest(request, taskRegistry, taskRegistry.resolveChatRequest, 'chat');
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

        // Process images only if requested (fetch remote URLs and resize/transcode)
        const processedMessages = await this._processImagesInMessages(
            opts.messages,
            modelConfig,
            effectiveRequest.image_processing
        );

        // Replace image blocks with descriptive text for non-vision models
        const messages = this._prepareImagesForModel(processedMessages, modelConfig);

        const context = await this._buildContextStats(messages, modelConfig, adapter);

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

        // Extract thinking tags from non-streaming content
        const message = result.choices?.[0]?.message;

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
            ? { ...rawRequest, messages: convertInputToMessages(rawRequest.input) }
            : rawRequest;

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(request.model, 'chat');

        if (modelConfig.adapter === 'responses') {
            return this._routeResponseNative(request, modelConfig, rawRequest);
        }

        const chatResult = await this.routeChatCompletion(request);

        if (chatResult.stream) {
            return {
                stream: true,
                generator: convertStreamToResponseEvents(chatResult.generator, rawRequest),
                context: chatResult.context,
                _format: 'responses'
            };
        }

        const response = chatCompletionsToResponse(chatResult, rawRequest);
        response.context = chatResult.context;
        return response;
    }

    async _routeResponseNative(request, modelConfig, rawRequest) {
        const adapter = this._getAdapter('responses');
        const opts = this._buildChatOptions(request, modelConfig);

        const processedMessages = await this._processImagesInMessages(opts.messages, modelConfig, request.image_processing);
        const messages = this._prepareImagesForModel(processedMessages, modelConfig);
        const context = await this._buildContextStats(messages, modelConfig, adapter);
        const resolvedMaxTokens = this._resolveChatMaxTokens(request, modelConfig);
        const responseContext = this._annotateContext(context, resolvedMaxTokens, request);

        const finalOpts = { ...opts, messages, maxTokens: resolvedMaxTokens, signal: request.signal };

        if (request.stream) {
            const nativeRequest = { ...rawRequest };
            if (resolvedMaxTokens != null) nativeRequest.max_output_tokens = resolvedMaxTokens;
            return {
                stream: true,
                generator: adapter.streamComplete(modelConfig, nativeRequest),
                context: responseContext,
                _format: 'responses-native'
            };
        }

        const nativeRequest = { ...rawRequest };
        if (resolvedMaxTokens != null) nativeRequest.max_output_tokens = resolvedMaxTokens;
        const result = await adapter.chatComplete(modelConfig, nativeRequest);
        result.context = responseContext;
        return result;
    }

    /**
     * Route an embedding request.
     * Passthrough — no batching, no chunking. The llama-cpp-gateway owns
     * all embedding batching/chunking logic since it has real ctxSize, VRAM,
     * and concurrency state.
     */
    async routeEmbedding(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('[ModelRouter] Request must be an object');
        }

        const taskRegistry = this.registry.getTaskRegistry();
        const { resolvedRequest, taskInfo } = this._resolveRequest(request, taskRegistry, taskRegistry.resolveGenericRequest, 'embedding');

        return this._executeWithFallback(
            taskInfo,
            'embedding',
            resolvedRequest,
            (modelConfig, req) => {
                const adapter = this._getAdapter(modelConfig.adapter);
                return adapter.createEmbedding(modelConfig, req);
            }
        );
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
        const { resolvedRequest, taskInfo } = this._resolveRequest(request, taskRegistry, taskRegistry.resolveGenericRequest, 'image');

        return this._executeWithFallback(
            taskInfo,
            'image',
            resolvedRequest,
            (modelConfig, req) => {
                const adapter = this._getAdapter(modelConfig.adapter);
                return adapter.generateImage(modelConfig, req);
            }
        );
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
        const { resolvedRequest, taskInfo } = this._resolveRequest(request, taskRegistry, taskRegistry.resolveGenericRequest, 'audio');

        return this._executeWithFallback(
            taskInfo,
            'audio',
            resolvedRequest,
            (modelConfig, req) => {
                const adapter = this._getAdapter(modelConfig.adapter);
                return adapter.synthesizeSpeech(modelConfig, req);
            }
        );
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

        const taskRegistry = this.registry.getTaskRegistry();
        const { resolvedRequest, taskInfo } = this._resolveRequest(request, taskRegistry, taskRegistry.resolveGenericRequest, 'video');

        return this._executeWithFallback(
            taskInfo,
            'video',
            resolvedRequest,
            (modelConfig, req) => {
                const adapter = this._getAdapter(modelConfig.adapter);
                return adapter.generateVideo(modelConfig, req);
            }
        );
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
        const thinking = this._resolveThinking(request, modelConfig);

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
            // Normalized thinking control
            enable_thinking: thinking.enable_thinking,
            chat_template_kwargs: thinking.chat_template_kwargs
        };
    }

    _resolveThinking(request, modelConfig) {
        const configExtra = modelConfig.extraBody || {};
        const configKwargs = configExtra.chat_template_kwargs || {};
        const configThinking = configKwargs.enable_thinking;

        const requestKwargs = request.chat_template_kwargs || {};
        const extraBodyKwargs = (request.extra_body || {}).chat_template_kwargs || {};

        const enable_thinking = request.enable_thinking ?? extraBodyKwargs.enable_thinking ?? requestKwargs.enable_thinking ?? configThinking;

        if (enable_thinking == null) {
            return {
                enable_thinking: undefined,
                chat_template_kwargs: Object.keys(requestKwargs).length > 0 ? requestKwargs : undefined
            };
        }

        return {
            enable_thinking,
            chat_template_kwargs: undefined
        };
    }

    /**
     * Resolve a request that may or may not have a task or model specified.
     * If no task and no model, falls back to the default task for the expected type.
     * Returns { resolvedRequest, taskInfo }.
     */
    _resolveRequest(request, taskRegistry, resolveFn, expectedType) {
        // If task is specified, use the task resolver
        if (request.task) {
            return resolveFn.call(taskRegistry, request);
        }

        // If model is specified, pass through without task
        if (request.model) {
            return { resolvedRequest: request, taskInfo: null };
        }

        // No task, no model — find the default task matching the expected type
        const defaultTasks = taskRegistry.getDefaultTasks();
        for (const { id, config } of defaultTasks) {
            const model = this.registry.get(config.model);
            if (model && model.type === expectedType) {
                return resolveFn.call(taskRegistry, { ...request, task: id });
            }
        }

        // No matching default task — pass through, resolveModel will throw
        return { resolvedRequest: request, taskInfo: null };
    }

    /**
     * Execute a request with fallback support.
     *
     * If the task has a fallback model and the primary is in cooldown,
     * routes directly to the fallback. Otherwise tries the primary;
     * on failure, records the failure and retries with the fallback.
     *
     * @param {Object} taskInfo - Task info from resolveChatRequest/resolveGenericRequest
     * @param {string} expectedType - Model type (chat, embedding, image, audio)
     * @param {Object} resolvedRequest - The resolved request with model set
     * @param {Function} fn - (modelConfig, resolvedRequest) => Promise<result>
     * @returns {Promise<Object>} Result from the adapter
     */
    async _executeWithFallback(taskInfo, expectedType, resolvedRequest, fn) {
        const primaryModel = resolvedRequest.model;
        const useFallback = taskInfo?.fallback && this.fallbackTracker.shouldUseFallback(taskInfo.id);
        const effectiveModel = useFallback ? taskInfo.fallback : primaryModel;

        const { id: modelId, config: modelConfig } = this.registry.resolveModel(effectiveModel, expectedType);

        logger.info(`Routing ${expectedType}`, {
            model: modelId,
            adapter: modelConfig.adapter,
            task: taskInfo?.id || null,
            fallback: effectiveModel !== primaryModel
        }, 'ModelRouter');

        try {
            const result = await fn(modelConfig, resolvedRequest);
            if (taskInfo) this.fallbackTracker.recordSuccess(taskInfo.id);
            return result;
        } catch (err) {
            // If we were using the primary and it has a fallback, switch to fallback
            if (taskInfo?.fallback && effectiveModel === taskInfo.model) {
                const cooldownMs = (taskInfo.fallbackCooldownMinutes ?? 1) * 60_000;
                this.fallbackTracker.recordFailure(taskInfo.id, taskInfo.model, cooldownMs, err);
                const { id: fbModelId, config: fbModelConfig } = this.registry.resolveModel(taskInfo.fallback, expectedType);
                logger.warn(`${expectedType} primary failed, using fallback`, {
                    task: taskInfo.id,
                    primaryModel: taskInfo.model,
                    fallbackModel: fbModelId,
                    error: err.message
                }, 'ModelRouter');
                return fn(fbModelConfig, resolvedRequest);
            }
            throw err;
        }
    }

    /**
     * Resolve the max output token budget for a chat request.
     *
     * Resolution order:
     * 1. Explicit client value (max_completion_tokens, max_tokens, maxTokens)
     * 2. Model config maxOutputTokens capability
     * 3. Available context window (context.available_tokens) — implicit budget
     *    from remaining context, capped at a reasonable output ratio.
     *
     * If no value can be resolved, returns null — the adapter will reject
     * with a clear error rather than silently using a guess.
     */
    _resolveChatMaxTokens(request, modelConfig, context) {
        const requestedMaxTokens = request.max_completion_tokens ?? request.max_tokens ?? request.maxTokens;
        if (requestedMaxTokens != null) {
            return requestedMaxTokens;
        }

        if (modelConfig?.capabilities?.maxOutputTokens != null) {
            return modelConfig.capabilities.maxOutputTokens;
        }

        // Implicit budget: use up to 80% of remaining context for output,
        // with a floor of 4096 so short conversations still get reasonable output.
        const availableTokens = context?.available_tokens;
        if (typeof availableTokens === 'number' && Number.isFinite(availableTokens) && availableTokens > 0) {
            return Math.max(Math.floor(availableTokens * 0.8), 4096);
        }

        // No budget resolvable — adapter will reject with clear error
        return null;
    }

    /**
     * Attach resolved token budget metadata to response context.
     */
    _annotateContext(context, resolvedMaxTokens, request) {
        const source = (request.max_completion_tokens != null || request.max_tokens != null || request.maxTokens != null)
            ? 'explicit'
            : 'implicit';

        const annotation = {
            resolved_max_tokens: resolvedMaxTokens,
            max_tokens_source: source
        };

        if (!context) return annotation;
        return { ...context, ...annotation };
    }

    /**
     * Estimate tokens for messages to populate context stats.
     */
    async _buildContextStats(messages, modelConfig, adapter) {
        const contextWindow = modelConfig.capabilities.contextWindow;
        
        let estimatedTokens = 0;
        if (messages.length > 0) {
            estimatedTokens = await this._estimateMessagesTokens(messages, adapter, modelConfig);
        }

        const available = Math.max(0, contextWindow - estimatedTokens);

        return {
            // camelCase (new clients)
            windowSize: contextWindow,
            usedTokens: estimatedTokens,
            availableTokens: isNaN(available) ? 0 : available,
            // snake_case (backward compat)
            window_size: contextWindow,
            used_tokens: estimatedTokens,
            available_tokens: isNaN(available) ? 0 : available,
            // metadata
            strategy_applied: false
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
     * Replace image_url blocks with descriptive text for non-vision models.
     * If the model supports vision, pass images through unchanged.
     */
    _prepareImagesForModel(messages, modelConfig) {
        const visionSupported = modelConfig.capabilities?.vision === true;
        if (visionSupported) {
            return messages;
        }

        const preparedMessages = [];
        for (const message of messages) {
            if (!Array.isArray(message.content)) {
                preparedMessages.push(message);
                continue;
            }

            const preparedContent = [];
            for (const part of message.content) {
                if (part.type === 'image_url') {
                    const imageUrl = part.image_url?.url || '';
                    const fileName = imageUrl.split('/').pop()?.split('?')[0] || 'image';
                    preparedContent.push({
                        type: 'text',
                        text: `[Image attached: ${fileName} — vision analysis has been performed and is shown above]`
                    });
                    continue;
                }
                preparedContent.push(part);
            }

            preparedMessages.push({
                ...message,
                content: preparedContent
            });
        }

        return preparedMessages;
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
