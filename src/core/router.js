import { createAdapters } from '../adapters/index.js';
import { TokenEstimator } from '../context/estimator.js';
import { ContextManager } from '../context/strategy.js';
import { snakeToCamel, stripThinking } from '../utils/format.js';

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
    }

    _isAsyncRequest(headers = {}) {
        return String(headers['x-async'] || headers['X-Async'] || '').toLowerCase() === 'true';
    }

    async _estimateMessagesTokens(messages, adapter, requestedModel) {
        const messageString = (messages || []).map(m => m.content).join('');
        return this.tokenEstimator.estimate(messageString, adapter, requestedModel);
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

    /**
     * Routes an incoming OpenAI standard chat completion payload to the appropriate adapter.
     */
    async route(payload, headers = {}, runtime = {}) {
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

        // --- Context Window Management Interceptor ---
        if (this.config.compaction?.enabled && opts.messages.length > 0) {
            let estimatedTokens = await this._estimateMessagesTokens(opts.messages, adapter, requestedModel);
            const contextWindow = await adapter.getContextWindow();
            const outputBuffer = opts.maxTokens !== undefined ? opts.maxTokens : 1024; // safe default buffer
            const availableTokens = contextWindow - outputBuffer;
            const exceedsAvailableTokens = estimatedTokens > availableTokens;

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
            if (shouldCompact && mode !== 'none') {
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

                if (activeSession && this.sessionStore) {
                    this.sessionStore.replaceMessages(sessionId, opts.messages);
                }
            }

            const context = this._buildContextPayload(contextWindow, estimatedTokens, strategyApplied);

            if (payload.stream) {
                return {
                    stream: true,
                    generator: adapter.streamComplete(opts, requestedModel),
                    context,
                    stripThinking: shouldStripThinking
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
     */
    async routeModels(headers = {}) {
        if (headers['x-provider']) {
            const providerName = headers['x-provider'].toLowerCase();
            const adapter = this.adapters.get(providerName);
            if (!adapter) {
                throw new Error(`[Router] No adapter found for provider: '${providerName}'`);
            }
            const models = await adapter.listModels();
            return { object: "list", data: models };
        }

        // If no specific provider, list from all
        let allModels = [];
        for (const [name, adapter] of this.adapters.entries()) {
            try {
                const models = await adapter.listModels();
                // Tag models with provider to avoid collisions if possible
                const taggedModels = models.map(m => ({...m, id: m.id.includes(':') ? m.id : `${name}:${m.id}`}));
                allModels = allModels.concat(taggedModels || []);
            } catch (err) {
                console.error(`[Router] Failed to list models for ${name}:`, err.message);
            }
        }
        return { object: "list", data: allModels };
    }
}
