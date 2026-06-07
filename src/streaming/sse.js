import { isAbortError } from '../utils/http.js';
import { getLogger } from '../utils/logger.js';
import { normalizeStreamChunk } from '../utils/response-normalizer.js';

const logger = getLogger();

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

    async process(chunkGenerator, contextPayload = null, streamOptions = undefined) {
        this.start();

        let seenUpstreamUsage = false;

        // Emit context stats as initial event so clients can display context window
        if (contextPayload && contextPayload.window_size) {
            this.res.write(`data: ${JSON.stringify({
                object: 'chat.completion.chunk',
                context: contextPayload
            })}\n\n`);
        }

        try {
            for await (let chunk of chunkGenerator) {
                if (!this.isActive) break;

                chunk = normalizeStreamChunk(chunk);
                const choice = chunk.choices?.[0];
                const delta = choice?.delta;

                if (delta) {
                    // Only delete null content if there's no reasoning_content —
                    // Copilot's BYOK consumer needs content to exist alongside reasoning.
                    if (delta.content === null && delta.reasoning_content === undefined) {
                        delete delta.content;
                    } else if (delta.content === null) {
                        delta.content = "";
                    }
                }

                // Track whether upstream provided usage data
                if (chunk.usage && (chunk.usage.prompt_tokens != null || chunk.usage.total_tokens != null)) {
                    seenUpstreamUsage = true;

                    // Override prompt_tokens with our estimate — upstream may report
                    // only uncached tokens (DeepSeek disk caching) or tokenizer-specific
                    // counts that don't reflect total context usage for the client display.
                    if (contextPayload && typeof contextPayload.used_tokens === 'number') {
                        const upstreamCompletion = chunk.usage.completion_tokens ?? 0;
                        chunk = {
                            ...chunk,
                            usage: {
                                prompt_tokens: contextPayload.used_tokens,
                                completion_tokens: upstreamCompletion,
                                total_tokens: contextPayload.used_tokens + upstreamCompletion
                            }
                        };
                    }
                }

                // Skip metadata-only chunks with empty choices (e.g. response.in_progress).
                // Usage-bearing chunks with empty choices are standard OpenAI format
                // (stream_options.include_usage) and Copilot handles them natively.
                if (chunk.choices && chunk.choices.length === 0 && !chunk.usage) {
                    continue;
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

            // Always inject the gateway's context estimate as a final usage chunk
            // if upstream didn't provide usage or provided partial (cached-only) data.
            // This ensures clients always see the full cumulative token count.
            if (this.isActive && contextPayload && typeof contextPayload.used_tokens === 'number') {
                const usage = {
                    prompt_tokens: contextPayload.used_tokens ?? 0,
                    completion_tokens: 0,
                    total_tokens: contextPayload.used_tokens ?? 0
                };
                // If upstream already gave us completion tokens, preserve them
                // (they get picked up by the override in the chunk loop)
                const injectedChunk = {
                    id: `chatcmpl-gw-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: '',
                    choices: [],
                    usage
                };
                this.res.write(`data: ${JSON.stringify(injectedChunk)}\n\n`);
            }

            if (this.isActive) {
                this.res.write('data: [DONE]\n\n');
            }
        } catch (err) {
            if (!isAbortError(err)) {
                logger.error('Streaming error', { error: err.message, stack: err.stack }, 'StreamHandler');
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
        logger.error('Stream error', { error: err.message, stack: err.stack }, 'StreamHandler');
        this.cleanup();
        if (!this.res.writableEnded) {
            this.res.end();
        }
    }
}
