import { createAdapters } from '../adapters/index.js';
import { TokenEstimator } from '../context/estimator.js';
import { ContextManager } from '../context/strategy.js';
import { MediaProcessorClient } from '../utils/media-client.js';
import { MediaStorage } from '../utils/storage.js';
import { ImageFetcher } from '../utils/image-fetcher.js';
import { snakeToCamel, stripThinking } from '../utils/format.js';
import { systemEvents, EVENT_TYPES } from './events.js';

export class Router {
    constructor(config, sessionStore = null, ticketRegistry = null) {
        if (!config) {
            throw new Error("Router requires a configuration object");
        }
        this.config = config;
        this.sessionStore = sessionStore;
        this.ticketRegistry = ticketRegistry;
        this.adapters = createAdapters(config.providers || {});
        this.defaultProvider = config.routing?.defaultProvider || 'lmstudio';
        this.tokenEstimator = new TokenEstimator(config);
        this.contextManager = new ContextManager(config);
        this.mediaProcessor = new MediaProcessorClient(config);
        this.mediaStorage = new MediaStorage(config);
        this.imageFetcher = new ImageFetcher(config.imageFetcher || {});
        
        // Models list cache - persists for server lifetime (models don't change at runtime)
        // Use refreshModelsCache() to force refresh if needed
        this.modelsCache = null;
    }

    _isAsyncRequest(headers = {}) {
        return String(headers['x-async'] || headers['X-Async'] || '').toLowerCase() === 'true';
    }

    async _estimateMessagesTokens(messages, adapter, requestedModel) {
        // Collect all text and parts to calculate tokens
        let totalTokens = 0;
        let messageString = "";

        for (const m of (messages || [])) {
            if (Array.isArray(m.content)) {
                totalTokens += await this.tokenEstimator.estimate(m.content, adapter, requestedModel);
                messageString += m.content.map(p => p.type === 'text' ? p.text : '').join('');
            } else {
                totalTokens += await this.tokenEstimator.estimate(String(m.content || ''), adapter, requestedModel);
                messageString += String(m.content || '');
            }
        }
        
        console.log(`[Router] Token estimation: chars=${messageString.length}, estimated=${totalTokens}`);
        return totalTokens;
    }

    _resolveCompactionConfig(payload, activeSession) {
        const globalConfig = {
            mode: this.config.compaction?.mode || 'truncate',
            preserveSystemPrompt: this.config.compaction?.preserveSystemPrompt,
            preserveLastN: this.config.compaction?.preserveLastN,
            targetRatio: this.config.compaction?.targetRatio,
            chunkSize: this.config.compaction?.chunkSize
        };

        const sessionConfig = activeSession?.context_strategy || (activeSession?.strategy ? { mode: activeSession.strategy } : {});
        const requestConfig = payload?.context_strategy ? snakeToCamel(payload.context_strategy) : {};

        const strategyConfig = {
            ...globalConfig,
            ...sessionConfig,
            ...requestConfig
        };

        return {
            mode: strategyConfig.mode || 'truncate',
            strategyConfig
        };
    }

    _estimateCompactionChunks(messages, mode, strategyConfig = {}) {
        if (mode !== 'rolling') return 1;

        const systemOffset = messages[0]?.role === 'system' ? 1 : 0;
        const bodyMessages = messages.slice(systemOffset);
        const combinedText = bodyMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
        const chunkSizeChars = (strategyConfig.chunkSize || this.config.compaction?.chunkSize || 3000) * 3;
        return Math.max(1, Math.ceil(combinedText.length / chunkSizeChars));
    }

    _buildContextPayload(contextWindow, usedTokens, strategyApplied) {
        return {
            window_size: contextWindow,
            used_tokens: usedTokens,
            available_tokens: Math.max(0, contextWindow - usedTokens),
            strategy_applied: strategyApplied
        };
    }

    _createProgressEmitter(onProgress, ticketId = null) {
        return (event) => {
            if (typeof onProgress === 'function') {
                onProgress(event);
            }
            if (ticketId && this.ticketRegistry) {
                this.ticketRegistry.addEvent(ticketId, event);
            }
        };
    }

    async _applyCompaction(messages, availableTokens, estimatedTokens, adapter, requestedModel, mode, strategyConfig, onProgress) {
        const emitProgress = this._createProgressEmitter(onProgress);
        const estimatedChunks = this._estimateCompactionChunks(messages, mode, strategyConfig);

        emitProgress({ type: 'compaction.start', data: { estimated_chunks: estimatedChunks } });
        if (mode !== 'rolling') {
            emitProgress({ type: 'compaction.progress', data: { chunk: 1, total: estimatedChunks } });
        }

        const strategyFn = typeof this.contextManager[mode] === 'function'
            ? this.contextManager[mode].bind(this.contextManager)
            : this.contextManager.truncate.bind(this.contextManager);

        const compactedMessages = await strategyFn(
            messages,
            availableTokens,
            this.tokenEstimator,
            adapter,
            strategyConfig,
            emitProgress
        );

        const finalTokens = await this._estimateMessagesTokens(compactedMessages, adapter, requestedModel);
        emitProgress({
            type: 'compaction.complete',
            data: {
                original_tokens: estimatedTokens,
                final_tokens: finalTokens
            }
        });

        return { compactedMessages, finalTokens, estimatedChunks };
    }

    _createAcceptedTicketPayload(ticket) {
        return {
            object: 'chat.completion.task',
            ticket: ticket.id,
            status: 'accepted',
            estimated_chunks: ticket.estimated_chunks,
            stream_url: `/v1/tasks/${ticket.id}/stream`
        };
    }

    _runAsyncCompletionTask(taskArgs) {
        const {
            ticket,
            adapter,
            requestedModel,
            opts,
            payload,
            estimatedTokens,
            contextWindow,
            availableTokens,
            needsCompaction,
            mode,
            strategyConfig,
            activeSession,
            sessionId,
            stripThinking: shouldStripThinking,
            thinkingConfig
        } = taskArgs;

        setImmediate(async () => {
            try {
                this.ticketRegistry.updateTicketStatus(ticket.id, 'processing');

                const emitProgress = this._createProgressEmitter(null, ticket.id);
                let finalMessages = [...opts.messages];
                let finalTokens = estimatedTokens;
                let strategyApplied = false;

                if (needsCompaction && mode !== 'none') {
                    const compaction = await this._applyCompaction(
                        opts.messages,
                        availableTokens,
                        estimatedTokens,
                        adapter,
                        requestedModel,
                        mode,
                        strategyConfig,
                        emitProgress
                    );
                    finalMessages = compaction.compactedMessages;
                    finalTokens = compaction.finalTokens;
                    strategyApplied = true;

                    if (activeSession && this.sessionStore && sessionId) {
                        this.sessionStore.replaceMessages(sessionId, finalMessages);
                    }
                }

                const context = this._buildContextPayload(contextWindow, finalTokens, strategyApplied);
                const finalOpts = { ...opts, messages: finalMessages };

                if (payload.stream) {
                    const generator = adapter.streamComplete(finalOpts, requestedModel);
                    for await (const chunk of generator) {
                        this.ticketRegistry.addEvent(ticket.id, { type: 'chunk', data: chunk });
                    }
                    this.ticketRegistry.addEvent(ticket.id, { type: 'context.status', data: context });
                    this.ticketRegistry.addEvent(ticket.id, { type: 'done', data: {} });
                    this.ticketRegistry.updateTicketStatus(ticket.id, 'complete', {
                        result: { stream: true, context }
                    });
                    return;
                }

                const result = await adapter.predict(finalOpts, requestedModel);
                result.context = context;
                
                // Strip thinking content if configured
                if (shouldStripThinking && result.choices?.[0]?.message?.content) {
                    result.choices[0].message.content = stripThinking(result.choices[0].message.content, thinkingConfig);
                }

                if (activeSession && this.sessionStore && sessionId) {
                    const assistantMessage = result.choices?.[0]?.message;
                    if (assistantMessage) {
                        this.sessionStore.appendMessages(sessionId, [assistantMessage]);
                    }
                }

                this.ticketRegistry.updateTicketStatus(ticket.id, 'complete', { result });
            } catch (error) {
                this.ticketRegistry.updateTicketStatus(ticket.id, 'failed', { error });
            }
        });
    }

    _resolveProviderAndModel(modelString, headers = {}) {
        let providerName = this.defaultProvider;
        let model = modelString;

        // 1. Check Header override
        if (headers['x-provider']) {
            providerName = headers['x-provider'].toLowerCase();
        } 
        // 2. Check namespaced model (e.g., 'ollama:llama3' or 'ollama:gemma3:12b')
        else if (modelString && modelString.includes(':')) {
            const firstColonIndex = modelString.indexOf(':');
            providerName = modelString.substring(0, firstColonIndex).toLowerCase();
            model = modelString.substring(firstColonIndex + 1);
        }

        const adapter = this.adapters.get(providerName);
        if (!adapter) {
            throw new Error(`[Router] No adapter found for provider: '${providerName}'`);
        }

        return { adapter, providerName, requestedModel: model || 'auto' };
    }

    _resolveEmbeddingProviderAndModel(modelString, headers = {}) {
        let providerName;
        let model = modelString;

        // 1. Check Header override
        if (headers['x-provider']) {
            providerName = headers['x-provider'].toLowerCase();
        } 
        // 2. Check namespaced model (e.g., 'ollama:nomic-embed')
        else if (modelString && modelString.includes(':')) {
            const firstColonIndex = modelString.indexOf(':');
            providerName = modelString.substring(0, firstColonIndex).toLowerCase();
            model = modelString.substring(firstColonIndex + 1);
        } else {
            // Priority 2: If request specifies a plain model name, search all providers with `embeddings: true`
            // and see if any of them naturally use this model. Wait, adapter.capabilities.embeddings is true, 
            // but we might not know if it explicitly hosts that *specific* model unless we do a deep check.
            // The spec says "search all providers with embeddings: true capability". If there's multiple, choose the first capable one?
            // Actually, we can check configured embeddingProvider first.
            if (this.config.routing?.embeddingProvider) {
                providerName = this.config.routing.embeddingProvider;
            } else {
                // Find any provider with embeddings capability
                for (const [name, pAdapter] of this.adapters.entries()) {
                    if (pAdapter.capabilities.embeddings) {
                        providerName = name;
                        break;
                    }
                }
                // Fall back to default provider if no others explicitly say yes
                if (!providerName) {
                    providerName = this.defaultProvider;
                }
            }
        }

        const adapter = this.adapters.get(providerName);
        if (!adapter) {
            throw new Error(`[Router] No adapter found for provider: '${providerName}'`);
        }
        
        if (!adapter.capabilities.embeddings) {
            throw new Error(`[Router] Provider '${providerName}' does not support embeddings.`);
        }

        return { adapter, providerName, requestedModel: model };
    }

    _inferCapabilitiesFromModelId(modelId = '') {
        const id = String(modelId || '').toLowerCase();
        return {
            embeddings: ['embed', 'embedding'].some(p => id.includes(p)),
            imageGeneration: ['dall-e', 'imagen', 'imagine', 'image', 'veo', 'easel', 'cogview', 'wanx', 'flux'].some(p => id.includes(p)) || id.startsWith('grok-'),
            tts: ['tts', 'text-to-speech', 'speech', 'audio'].some(p => id.includes(p)) || id.includes('gemini-2.0') || id.includes('gemini-2.5') || id.includes('gemini-3'),
            stt: ['stt', 'whisper', 'asr', 'transcribe', 'speech-to-text', 'audio'].some(p => id.includes(p)) || id.includes('gemini-2.0') || id.includes('gemini-2.5') || id.includes('gemini-3')
        };
    }

    _normalizeModelCapabilities(model = {}) {
        const source = model.capabilities || {};
        const inferred = this._inferCapabilitiesFromModelId(model.id);

        const normalized = {
            chat: source.chat,
            embeddings: source.embeddings,
            structuredOutput: source.structuredOutput ?? source.structured_output,
            streaming: source.streaming,
            vision: source.vision,
            imageGeneration: source.imageGeneration ?? source.image_generation,
            tts: source.tts,
            stt: source.stt,
            context_window: source.context_window ?? source.contextWindow
        };

        if (normalized.embeddings === undefined) normalized.embeddings = inferred.embeddings;
        if (normalized.imageGeneration === undefined) normalized.imageGeneration = inferred.imageGeneration;
        if (normalized.tts === undefined) normalized.tts = inferred.tts;
        if (normalized.stt === undefined) normalized.stt = inferred.stt;

        if (normalized.chat === undefined) {
            normalized.chat = !normalized.embeddings && !normalized.imageGeneration && !normalized.tts && !normalized.stt;
        }
        if (normalized.structuredOutput === undefined) normalized.structuredOutput = false;
        if (normalized.streaming === undefined) normalized.streaming = false;
        if (normalized.vision === undefined) normalized.vision = false;

        return normalized;
    }

    _resolveProviderForCapability(modelString, headers = {}, capabilityKey) {
        if (!capabilityKey) {
            throw new Error('[Router] Missing capability key');
        }

        let providerName = this.defaultProvider;
        let model = modelString;

        if (headers['x-provider']) {
            providerName = headers['x-provider'].toLowerCase();
        } else if (modelString && modelString.includes(':')) {
            const firstColonIndex = modelString.indexOf(':');
            providerName = modelString.substring(0, firstColonIndex).toLowerCase();
            model = modelString.substring(firstColonIndex + 1);
        } else {
            const defaultAdapter = this.adapters.get(providerName);
            if (!defaultAdapter?.capabilities?.[capabilityKey]) {
                const firstCapable = [...this.adapters.entries()].find(([, adapter]) => adapter.capabilities?.[capabilityKey]);
                if (firstCapable) {
                    providerName = firstCapable[0];
                }
            }
        }

        const adapter = this.adapters.get(providerName);
        if (!adapter) {
            throw new Error(`[Router] No adapter found for provider: '${providerName}'`);
        }

        if (!adapter.capabilities?.[capabilityKey]) {
            const err = new Error(`[Router] 422 Unprocessable Entity: Provider '${providerName}' does not support ${capabilityKey}.`);
            err.status = 422;
            throw err;
        }

        return { adapter, providerName, requestedModel: model || 'auto' };
    }

    /**
     * Routes an incoming OpenAI standard chat completion payload to the appropriate adapter.
     */
    async route(payload, headers = {}, runtime = {}) {
        console.log(`[Router] route() called with model=${payload.model}, messages=${payload.messages?.length}`);
        if (!payload) {
            throw new Error("[Router] Missing request payload");
        }

        const onProgress = runtime.onProgress;

        const { adapter, providerName, requestedModel } = this._resolveProviderAndModel(payload.model, headers);
        const providerConfig = this.config.providers?.[providerName] || {};
        
        // Parse stripThinking configuration
        // Can be: boolean true, or object { enabled: true, tags: [...], orphanCloseAsSeparator: true }
        const stripThinkingConfig = providerConfig.stripThinking;
        const shouldStripThinking = stripThinkingConfig === true || 
            (typeof stripThinkingConfig === 'object' && stripThinkingConfig.enabled !== false);
        
        // Build thinking config for stripper (undefined means use defaults)
        const thinkingConfig = typeof stripThinkingConfig === 'object' && stripThinkingConfig !== null
            ? { tags: stripThinkingConfig.tags, orphanCloseAsSeparator: stripThinkingConfig.orphanCloseAsSeparator }
            : undefined;

        // Guard: Structured Output capability
        if (payload.response_format) {
            const type = payload.response_format.type;
            if (type === 'json_object' || type === 'json_schema') {
                if (!adapter.capabilities.structuredOutput) {
                    throw new Error(`[Router] Provider '${adapter.name}' does not support structured output (JSON).`);
                }
            }
        }

        // Guard: Multimodal / Vision Support
        let imageCount = 0;
        const hasVisionContent = payload.messages && payload.messages.some(m => {
            if (Array.isArray(m.content)) {
                const images = m.content.filter(part => part.type === 'image_url');
                imageCount += images.length;
                return images.length > 0;
            }
            return false;
        });
        
        if (hasVisionContent) {
            console.log(`[Router] Multimodal request detected: image_count=${imageCount}, provider=${adapter.name}, model=${requestedModel}`);
        }

        if (hasVisionContent && !adapter.capabilities.vision) {
            console.warn(`[RouterFallback] Attempted multimodal request to non-vision capable provider: ${adapter.name}`);
            const err = new Error(`[Router] 422 Unprocessable Entity: Provider '${adapter.name}' does not support vision/image inputs.`);
            err.status = 422;
            throw err;
        }

        // Map standard OpenAI payload properties to adapter format
        const opts = {
            prompt: payload.prompt,
            systemPrompt: payload.systemPrompt,
            maxTokens: payload.max_tokens,
            temperature: payload.temperature,
            schema: payload.response_format?.json_schema?.schema || undefined   
        };

        let activeSession = null;
        const sessionId = headers['x-session-id'] || headers['X-Session-Id'];
        if (sessionId && this.sessionStore) {
            activeSession = this.sessionStore.getSession(sessionId);
            if (!activeSession) {
                const err = new Error(`[Router] 404 Session Not Found: ${sessionId}`);
                err.status = 404;
                throw err;
            }
            if (payload.messages && payload.messages.length > 0) {
                this.sessionStore.appendMessages(sessionId, payload.messages);
            }
            opts.messages = [...activeSession.messages];
        } else {
            opts.messages = payload.messages || [];
        }

        // --- Image Fetching & Media Processing Interceptor ---
        if (hasVisionContent) {
            console.log(`[Router] Processing ${imageCount} vision content items...`);
            for (const msg of opts.messages) {
                if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === 'image_url' && part.image_url?.url) {
                            const url = part.image_url.url;
                            
                            // Fetch remote URLs and convert to base64
                            if (!url.startsWith('data:')) {
                                try {
                                    console.log(`[Router] Fetching remote image: ${url.substring(0, 100)}...`);
                                    const fetched = await this.imageFetcher.fetchImage(url);
                                    part.image_url.url = `data:${fetched.mimeType};base64,${fetched.base64}`;
                                    console.log(`[Router] Successfully fetched remote image (${fetched.size} bytes, ${fetched.mimeType})`);
                                } catch (fetchErr) {
                                    console.error(`[Router] Failed to fetch remote image:`, fetchErr.message);
                                    const err = new Error(`[Router] 400 Bad Request: Failed to fetch image - ${fetchErr.message}`);
                                    err.status = 400;
                                    throw err;
                                }
                            }
                            
                            // Apply MediaProcessor optimization if enabled
                            if (this.mediaProcessor.isEnabled) {
                                const currentUrl = part.image_url.url;
                                const match = currentUrl.match(/^data:([^;]+);base64,(.+)$/);
                                if (match) {
                                    const mimeType = match[1];
                                    const base64Data = match[2];
                                    // Extract detail parameter (low/high/auto)
                                    const detail = part.image_url?.detail || 'auto';
                                    try {
                                        const optimizedBase64 = await this.mediaProcessor.optimizeImage(base64Data, mimeType, detail, providerName);
                                        // Make sure we update the MIME Type string correctly so Gemini 
                                        // doesn't think it's a PNG if it was converted into a JPEG by the Media Processor
                                        // Media processor currently defaults strictly to 'jpeg'
                                        part.image_url.url = `data:image/jpeg;base64,${optimizedBase64}`;
                                        console.log(`[Router] Successfully optimized image via MediaProcessor Node (detail=${detail}). Original MIME: ${mimeType} -> New: image/jpeg`);
                                    } catch (err) {
                                        console.warn(`[Router] Failed to process image inline, continuing with original:`, err.message);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // --- Context Window Management Interceptor ---
        if (this.config.compaction?.enabled && opts.messages.length > 0) {
            let estimatedTokens = await this._estimateMessagesTokens(opts.messages, adapter, requestedModel);
            const contextWindow = await adapter.getContextWindow();
            const outputBuffer = opts.maxTokens !== undefined ? opts.maxTokens : 1024; // safe default buffer
            const safetyMargin = Math.floor(contextWindow * 0.20); // 20% safety margin for model overhead
            const availableTokens = contextWindow - outputBuffer - safetyMargin;
            const exceedsAvailableTokens = estimatedTokens > availableTokens;
            
            console.log(`[Router] Context: window=${contextWindow}, estimated=${estimatedTokens}, available=${availableTokens}, safetyMargin=${safetyMargin}, exceeds=${exceedsAvailableTokens}`);

            const minTokens = this.config.compaction.minTokensToCompact || 2000;
            const shouldCompact = estimatedTokens >= minTokens && exceedsAvailableTokens;
            const { mode, strategyConfig } = this._resolveCompactionConfig(payload, activeSession);

            if (mode === 'none' && exceedsAvailableTokens) {
                const err = new Error(`[Router] 413 Payload Too Large: Input tokens (${estimatedTokens}) exceed available context window (${availableTokens}).`);
                err.status = 413;
                throw err;
            }

            const isAsync = this._isAsyncRequest(headers);
            if (isAsync && shouldCompact && this.ticketRegistry) {
                const estimatedChunks = this._estimateCompactionChunks(opts.messages, mode, strategyConfig);
                const ticket = this.ticketRegistry.createTicket(estimatedChunks);

                this._runAsyncCompletionTask({
                    ticket,
                    adapter,
                    requestedModel,
                    opts,
                    payload,
                    estimatedTokens,
                    contextWindow,
                    availableTokens,
                    needsCompaction: shouldCompact,
                    mode,
                    strategyConfig,
                    activeSession,
                    sessionId,
                    stripThinking: shouldStripThinking
                });

                return {
                    isAsyncTicket: true,
                    ticketData: this._createAcceptedTicketPayload(ticket)
                };
            }

            let strategyApplied = false;
            console.log(`[Router] shouldCompact=${shouldCompact}, mode=${mode}, minTokens=${minTokens}, estimatedTokens=${estimatedTokens}`);
            if (shouldCompact && mode !== 'none') {
                console.log(`[Router] Applying compaction: mode=${mode}, available=${availableTokens}`);
                systemEvents.emit(EVENT_TYPES.COMPACTION_STARTED, { sessionId, mode, estimatedTokens, availableTokens });
                
                const compaction = await this._applyCompaction(
                    opts.messages,
                    availableTokens,
                    estimatedTokens,
                    adapter,
                    requestedModel,
                    mode,
                    strategyConfig,
                    onProgress
                );

                opts.messages = compaction.compactedMessages;
                estimatedTokens = compaction.finalTokens;
                strategyApplied = true;
                
                systemEvents.emit(EVENT_TYPES.COMPACTION_COMPLETED, { 
                    sessionId, 
                    finalTokens: estimatedTokens, 
                    originalCount: opts.messages.length,
                    compactedCount: compaction.compactedMessages.length 
                });
                
                console.log(`[Router] Compaction result: finalTokens=${estimatedTokens}, originalMessages=${opts.messages.length}, compactedMessages=${compaction.compactedMessages.length}`);

                if (activeSession && this.sessionStore) {
                    this.sessionStore.replaceMessages(sessionId, opts.messages);
                }
            } else {
                console.log(`[Router] Skipping compaction: shouldCompact=${shouldCompact}, mode=${mode}`);
            }

            const context = this._buildContextPayload(contextWindow, estimatedTokens, strategyApplied);

            if (payload.stream) {
                return {
                    stream: true,
                    generator: adapter.streamComplete(opts, requestedModel),
                    context,
                    stripThinking: shouldStripThinking,
                    thinkingConfig
                };
            }

            const result = await adapter.predict(opts, requestedModel);
            result.context = context;
            
            // Strip thinking content if configured
            if (shouldStripThinking && result.choices?.[0]?.message?.content) {
                result.choices[0].message.content = stripThinking(result.choices[0].message.content, thinkingConfig);
            }
            
            if (activeSession && this.sessionStore) {
                const assistantMessage = result.choices?.[0]?.message;
                if (assistantMessage) {
                    this.sessionStore.appendMessages(sessionId, [assistantMessage]);
                }
            }
            return result;
        }
        // ---------------------------------------------

        if (payload.stream) {
            return {
                stream: true,
                generator: adapter.streamComplete(opts, requestedModel),
                context: null,
                stripThinking: shouldStripThinking,
                thinkingConfig
            };
        } else {
            const result = await adapter.predict(opts, requestedModel);
            
            // Strip thinking content if configured
            if (shouldStripThinking && result.choices?.[0]?.message?.content) {
                result.choices[0].message.content = stripThinking(result.choices[0].message.content, thinkingConfig);
            }
            
            if (activeSession && this.sessionStore) {
                const assistantMessage = result.choices?.[0]?.message;
                if (assistantMessage) {
                    this.sessionStore.appendMessages(sessionId, [assistantMessage]);
                }
            }
            result.context = null;
            return result;
        }
    }

    async routeImageGeneration(payload, headers = {}) {
        if (!payload) {
            throw new Error('[Router] Missing image generation payload');
        }
        if (!payload.prompt) {
            const err = new Error('[Router] 400 Bad Request: Missing required field "prompt" for image generation.');
            err.status = 400;
            throw err;
        }

        const { adapter, requestedModel } = this._resolveProviderForCapability(payload.model, headers, 'imageGeneration');

        const runTask = async () => {
            const startedAt = Date.now();
            const rawResult = await adapter.generateImage(payload, requestedModel);
            const result = { ...rawResult, stream: false };

            if (this.mediaStorage.enabled && Array.isArray(result.data)) {
                const mapped = [];
                for (const item of result.data) {
                    if (item?.b64_json) {
                        const stored = await this.mediaStorage.saveBase64(item.b64_json, '.png');
                        mapped.push({
                            ...item,
                            local_url: stored.url
                        });
                    } else {
                        mapped.push(item);
                    }
                }
                result.data = mapped;
            }

            console.log(`[Router] media_generation_latency=${Date.now() - startedAt}ms`);
            return result;
        };

        if (this.ticketRegistry) {
            const ticket = this.ticketRegistry.createTicket(1);
            this.ticketRegistry.updateTicketStatus(ticket.id, 'processing');

            setImmediate(async () => {
                try {
                    const result = await runTask();
                    this.ticketRegistry.updateTicketStatus(ticket.id, 'complete', { result });
                } catch (error) {
                    this.ticketRegistry.updateTicketStatus(ticket.id, 'failed', { error });
                }
            });

            return {
                isAsyncTicket: true,
                ticketData: {
                    object: 'media.generation.task',
                    ticket: ticket.id,
                    status: 'accepted',
                    estimated_chunks: 1,
                    stream_url: `/v1/tasks/${ticket.id}/stream`
                }
            };
        }

        return await runTask();
    }

    async routeAudioSpeech(payload, headers = {}) {
        if (!payload) {
            throw new Error('[Router] Missing audio speech payload');
        }
        if (!payload.input) {
            const err = new Error('[Router] 400 Bad Request: Missing required field "input" for audio speech.');
            err.status = 400;
            throw err;
        }
        if (!payload.voice) {
            const err = new Error('[Router] 400 Bad Request: Missing required field "voice" for audio speech.');
            err.status = 400;
            throw err;
        }

        const { adapter, requestedModel } = this._resolveProviderForCapability(payload.model, headers, 'tts');
        return await adapter.synthesizeSpeech(payload, requestedModel);
    }

    /**
     * Routes an incoming OpenAI standard embedding payload to the appropriate adapter.
     */
    async routeEmbeddings(payload, headers = {}) {
        if (!payload) {
            throw new Error("[Router] Missing request payload");
        }

        const { adapter, requestedModel } = this._resolveEmbeddingProviderAndModel(payload.model, headers);

        // Check if the input is batch, use adapter's embedBatch if it exists and supports batching
        if (Array.isArray(payload.input) && payload.input.length > 1) {
             if (adapter.capabilities.batch && typeof adapter.embedBatch === 'function') {
                 return adapter.embedBatch(payload.input, requestedModel);
             } else {
                 // Fall back to parallel mapping if no bulk handler exists natively
                 const results = await Promise.all(payload.input.map(text => adapter.embedText(text, requestedModel)));
                 // Some adapters return their own specific json shape on embedText (OpenAI wrapper does). 
                 // So we must standardise this locally to avoid weird merged maps. Wait, adapters should return the full payload according to their own shape, or pure embeddings?
                 // Phase 7 expects OpenAI-compatible response. If mapping individually, we need to stitch the OpenAI format array.
                 if (results.length > 0 && results[0].data) {
                     // Try to merge standard OpenAI payload structures
                     const data = results.flatMap((r, i) => {
                         return r.data.map(d => ({ ...d, index: i })); 
                     });
                     let totalPromptTokens = results.reduce((acc, curr) => acc + (curr.usage?.prompt_tokens || 0), 0);
                     let totalTokens = results.reduce((acc, curr) => acc + (curr.usage?.total_tokens || 0), 0);
                     return {
                         object: "list",
                         data,
                         model: results[0].model || requestedModel,
                         usage: {
                             prompt_tokens: totalPromptTokens,
                             total_tokens: totalTokens
                         }
                     };
                 }
                 return results;
             }
        }

        return adapter.embedText(payload.input, requestedModel);
    }

    /**
     * Routes an incoming models list request to either all adapters or a specific one.
     * Each model includes an explicit 'provider' field for clear identification.
     * Uses server-lifetime cache since models don't change at runtime.
     */
    async routeModels(headers = {}, query = {}) {
        // Return cached models if available (unless specific provider requested or refresh forced)
        const forceRefresh = headers['x-refresh-cache'] === 'true' || query.refresh === 'true';
        
        if (forceRefresh) {
            console.log('[Router] Force refresh requested, clearing models cache...');
            this.modelsCache = null;
        }

        if (!headers['x-provider'] && this.modelsCache) {
            console.log(`[Router] Returning cached models (${this.modelsCache.length} total)`);
            return { object: "list", data: this.modelsCache };
        }

        if (headers['x-provider']) {
            const providerName = headers['x-provider'].toLowerCase();
            const adapter = this.adapters.get(providerName);
            if (!adapter) {
                throw new Error(`[Router] No adapter found for provider: '${providerName}'`);
            }
            const models = await adapter.listModels();
            const modelsWithProvider = models.map(m => ({
                ...m,
                provider: providerName,
                capabilities: this._normalizeModelCapabilities(m)
            }));
            return { object: "list", data: modelsWithProvider };
        }

        // Fetch from all providers in parallel with timeout
        console.log('[Router] Fetching models from all providers...');
        const fetchPromises = [];
        for (const [name, adapter] of this.adapters.entries()) {
            const promise = Promise.race([
                adapter.listModels().then(models => {
                    const modelsWithProvider = models.map(m => ({
                        ...m,
                        provider: name,
                        capabilities: this._normalizeModelCapabilities(m)
                    }));
                    return { success: true, models: modelsWithProvider, provider: name };
                }),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout')), 5000)
                )
            ]).catch(err => {
                console.error(`[Router] Failed to list models for ${name}:`, err.message);
                return { success: false, models: [], provider: name };
            });
            fetchPromises.push(promise);
        }

        const results = await Promise.all(fetchPromises);
        const allModels = results.flatMap(r => r.models);
        
        // Update cache (persists for server lifetime)
        this.modelsCache = allModels;
        
        console.log(`[Router] Listed models from ${results.filter(r => r.success).length}/${this.adapters.size} providers, cached permanently`);
        return { object: "list", data: allModels };
    }

    /**
     * Force refresh of models cache (useful for admin operations or adding new providers)
     */
    async refreshModelsCache() {
        console.log('[Router] Refreshing models cache...');
        this.modelsCache = null;
        return this.routeModels({});
    }
}
