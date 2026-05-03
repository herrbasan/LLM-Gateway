import { createThinkingExtractor } from '../utils/format.js';
import { isAbortError } from '../utils/http.js';
import { normalizeStreamChunk } from '../utils/response-normalizer.js';

export class StreamHandler {
    constructor(res, options = {}) {
        this.res = res;
        this.heartbeatIntervalMs = options?.heartbeatIntervalMs || 15000;
        this.heartbeatInterval = null;
        this.isActive = true;
        this.started = false;
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.res.setHeader('Content-Type', 'text/event-stream');
        this.res.setHeader('Cache-Control', 'no-cache');
        this.res.setHeader('Connection', 'keep-alive');
        this.res.flushHeaders();

        // Keep-Alives/Heartbeat
        this.heartbeatInterval = setInterval(() => {
            if (this.isActive) {
                this.res.write(': heartbeat\n\n');
            }
        }, this.heartbeatIntervalMs);

        this.res.on('close', () => {
            this.cleanup();
        });
    }

    emitEvent(type, data) {
        if (!this.isActive) return;
        if (!this.started) this.start();
        this.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    emitDeltaEvent(chunk) {
        if (!this.isActive) return;
        if (!this.started) this.start();
        const payloadStr = `data: ${JSON.stringify(chunk)}\n\n`;
        this.res.write(payloadStr);
    }

    cleanup() {
        this.isActive = false;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    async process(chunkGenerator, contextPayload = null, stripThinking = false, thinkingConfig = undefined, streamOptions = undefined) {
        this.start();

        const thinkingExtractor = createThinkingExtractor();

        let finalId = null;
        let finalModel = null;
        let finalProvider = null;
        let capturedUsage = null;

        try {
            for await (let chunk of chunkGenerator) {
                if (!this.isActive) break;

                finalId = chunk.id;
                finalModel = chunk.model;
                finalProvider = chunk.provider;

                if (chunk.usage && (chunk.usage.prompt_tokens || chunk.usage.completion_tokens)) {
                    capturedUsage = chunk.usage;
                }

                chunk = normalizeStreamChunk(chunk);
                const choice = chunk.choices?.[0];
                const delta = choice?.delta;
                const originalFinishReason = choice?.finish_reason;
                const originalToolCalls = delta?.tool_calls;

                if (delta) {
                    if (delta.content === null) delete delta.content;

                    if (delta.content) {
                        const emissions = thinkingExtractor.process(delta.content);

                        if (emissions.length === 0) {
                            delete delta.content;
                        } else if (emissions.length === 1) {
                            if (emissions[0].content !== undefined) {
                                delta.content = emissions[0].content || undefined;
                            } else {
                                delete delta.content;
                            }
                            if (emissions[0].reasoning_content !== undefined) {
                                delta.reasoning_content = emissions[0].reasoning_content;
                            }
                        } else {
                            for (let i = 0; i < emissions.length - 1; i++) {
                                const preDelta = {};
                                if (emissions[i].content !== undefined) preDelta.content = emissions[i].content;
                                if (emissions[i].reasoning_content !== undefined) preDelta.reasoning_content = emissions[i].reasoning_content;
                                if (delta.role) preDelta.role = delta.role;
                                if (delta.function_call) preDelta.function_call = delta.function_call;

                                const preChunk = {
                                    ...chunk,
                                    choices: [{
                                        ...choice,
                                        delta: preDelta,
                                        finish_reason: null
                                    }]
                                };
                                this.res.write(`data: ${JSON.stringify(preChunk)}\n\n`);
                            }

                            const last = emissions[emissions.length - 1];
                            if (last.content !== undefined) {
                                delta.content = last.content || undefined;
                            } else {
                                delete delta.content;
                            }
                            if (last.reasoning_content !== undefined) {
                                delta.reasoning_content = last.reasoning_content;
                            }
                        }
                    }

                    if (stripThinking && delta.reasoning_content !== undefined) {
                        delete delta.reasoning_content;
                    }
                }

                if (streamOptions?.include_usage === true) {
                    chunk.usage = null;
                }

                const payloadStr = `data: ${JSON.stringify(chunk)}\n\n`;

                const canContinue = this.res.write(payloadStr);
                if (!canContinue) {
                    await new Promise(resolve => {
                        const cleanup = () => {
                            this.res.off('drain', resolveHandler);
                            this.res.off('close', resolveHandler);
                            this.res.off('error', resolveHandler);
                            resolve();
                        };
                        const resolveHandler = () => cleanup();

                        this.res.once('drain', resolveHandler);
                        this.res.once('close', resolveHandler);
                        this.res.once('error', resolveHandler);
                    });
                }
            }

            const flushEmissions = thinkingExtractor.flush();
            for (const emission of flushEmissions) {
                const flushDelta = {};
                if (emission.content !== undefined) flushDelta.content = emission.content;
                if (emission.reasoning_content !== undefined) flushDelta.reasoning_content = emission.reasoning_content;

                if (flushDelta.content || flushDelta.reasoning_content) {
                    const extraChunk = {
                        id: finalId || `chatcmpl-${Date.now()}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: finalModel || 'unknown',
                        provider: finalProvider || 'unknown',
                        choices: [{ delta: flushDelta }]
                    };
                    if (streamOptions?.include_usage === true) {
                        extraChunk.usage = null;
                    }
                    this.res.write(`data: ${JSON.stringify(extraChunk)}\n\n`);
                }
            }

            if (this.isActive) {
                const usage = capturedUsage || {
                    prompt_tokens: contextPayload?.promptTokens || contextPayload?.prompt_tokens || 0,
                    completion_tokens: contextPayload?.completionTokens || contextPayload?.completion_tokens || 0,
                    total_tokens: contextPayload?.totalTokens || contextPayload?.total_tokens || 0
                };

                const finalUsageChunk = {
                    id: finalId || `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: finalModel || 'unknown',
                    provider: finalProvider || 'unknown',
                    choices: [],
                    usage
                };
                this.res.write(`data: ${JSON.stringify(finalUsageChunk)}\n\n`);

                this.res.write('data: [DONE]\n\n');
            }
        } catch (err) {
            if (!isAbortError(err)) {
                console.error('[StreamHandler] Streaming error:', err);
            }
        } finally {
            this.cleanup();
            if (!this.res.writableEnded) {
                this.res.end();
            }
        }
    }

    end(data) {
        if (this.isActive) {
            this.res.write(`data: ${JSON.stringify(data)}\n\n`);
            this.res.write('data: [DONE]\n\n');
        }
        this.cleanup();
        if (!this.res.writableEnded) {
            this.res.end();
        }
    }

    error(err) {
        console.error('[StreamHandler] Error:', err);
        this.cleanup();
        if (!this.res.writableEnded) {
            this.res.end();
        }
    }
}
