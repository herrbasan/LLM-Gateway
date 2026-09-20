import { isAbortError } from '../utils/http.js';
import { getLogger } from '../utils/logger.js';
import { normalizeStreamChunk } from '../utils/response-normalizer.js';
import { logFailure } from '../utils/failure-log.js';

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

    cleanup() {
        this.isActive = false;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    async process(chunkGenerator, contextPayload = null, meta = null) {
        let seenUpstreamUsage = false;
        let hasContent = false;
        // Frames that arrived before any content. Writing one flushes the SSE
        // headers and forfeits the HTTP-error path, so they wait here until
        // content proves the stream is real. A stream that never produces content
        // therefore reaches the zero-content guard below with headers unsent, and
        // the client gets a real error instead of a 200 that claims success.
        const withheld = [];
        // meta: { model, adapter } — identifies the operation in error logs so a
        // hung upstream names its model instead of arriving as an anonymous
        // timeout. Falls back to {} so log lines never carry undefined fields.
        const opMeta = meta || {};
        // Headers are NOT flushed up front. We defer start() until the first
        // chunk is ready to be written. This keeps the HTTP response mutable
        // (status code + body) until we know the upstream actually produced
        // output. If the generator throws or ends with nothing to send, the
        // caller can still respond with a proper HTTP error status + JSON body
        // — which Copilot's BYOK consumer surfaces clearly, instead of the
        // generic "Response contained no choices" it emits when an SSE stream
        // delivers only an in-band error chunk (which it ignores).
        let headersSent = false;

        const sendChunk = (chunk) => {
            if (!headersSent) {
                this.start();
                headersSent = true;
            }
            return this.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        };

        const writeWithBackpressure = async (chunk) => {
            if (sendChunk(chunk)) return;
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
        };

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

                    // Track whether this chunk contributes meaningful content.
                    if (
                        (typeof delta.content === 'string' && delta.content.length > 0) ||
                        delta.tool_calls != null ||
                        delta.function_call != null ||
                        delta.reasoning_content != null
                    ) {
                        hasContent = true;
                    }
                }

                // Track whether upstream provided usage data
                if (chunk.usage && (chunk.usage.prompt_tokens != null || chunk.usage.total_tokens != null)) {
                    seenUpstreamUsage = true;
                    // Upstream provider's actual usage numbers pass through unchanged.
                    // Client accumulates token counts itself across the conversation.
                }

                // Skip metadata-only chunks with empty choices (e.g. response.in_progress).
                // Usage-bearing chunks with empty choices are standard OpenAI format
                // (stream_options.include_usage) and Copilot handles them natively.
                if (chunk.choices && chunk.choices.length === 0 && !chunk.usage) {
                    continue;
                }

                // Attach the gateway's context telemetry to the chunk that carries
                // finish_reason. This is the natural "done" marker for OpenAI-spec
                // clients — and for our chat app's SSE parser (which reads
                // dataObj.context only when choices[0].finish_reason is present).
                // Without this, the chat app's per-message and overall context
                // displays freeze on the value computed at chat-load time.
                // Copilot ignores extra fields on a chunk, so this is spec-safe.
                if (choice?.finish_reason && contextPayload && typeof contextPayload.window_size === 'number') {
                    chunk.context = {
                        window_size: contextPayload.window_size,
                        used_tokens: contextPayload.used_tokens ?? 0,
                        available_tokens: contextPayload.available_tokens ?? 0,
                        strategy_applied: contextPayload.strategy_applied ?? false
                    };
                }

                // Nothing worth sending yet — hold the frame. The first content
                // chunk releases the buffer and flushes headers in order.
                if (!hasContent) {
                    withheld.push(chunk);
                    continue;
                }
                if (withheld.length > 0) {
                    for (const held of withheld) {
                        await writeWithBackpressure(held);
                    }
                    withheld.length = 0;
                }

                await writeWithBackpressure(chunk);
            }

            // Always inject the gateway's context estimate as a final usage chunk
            // if upstream didn't provide usage or provided partial (cached-only) data.
            // This ensures clients always see the full cumulative token count.
            if (headersSent && contextPayload && typeof contextPayload.used_tokens === 'number') {
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
                sendChunk(injectedChunk);
            }

            // CRITICAL: Copilot's BYOK parser accumulates delta.content across chunks.
            // If zero content was delivered, the upstream produced nothing. Throw so
            // the caller responds with a proper HTTP error status + JSON body — which
            // Copilot surfaces clearly. This is the only branch reachable here: the
            // withheld buffer guarantees headers are still unsent when nothing was
            // produced, so there is no in-band fallback to fall back to.
            if (!hasContent) {
                logFailure({
                    logger,
                    component: 'StreamHandler',
                    message: 'Stream produced zero content',
                    meta: { ...opMeta, ...contextPayload }
                });
                // Nothing was written, so the response is still mutable and the
                // caller can answer with a real HTTP error. Withholding the
                // pre-content frames (see `withheld`) is what keeps this the only
                // reachable branch: a stream that produced nothing used to flush
                // headers with its finish chunk and can no longer do so.
                const err = new Error('Upstream returned no content.');
                err.code = 'ZERO_CONTENT';
                err.type = 'zero_content_error';
                throw err;
            }

            // Do not emit gateway-specific named SSE events (e.g. context.status)
            // inside an OpenAI-compatible chat completion stream. Clients that
            // consume every data: line as a chat.completion.chunk fail schema
            // validation because the payload has no choices/error union. Context
            // metadata is attached to the finish_reason chunk and the final
            // injected usage chunk's prompt_tokens/total_tokens.

            if (headersSent && this.isActive) {
                this.res.write('data: [DONE]\n\n');
            }
        } catch (err) {
            if (isAbortError(err)) {
                // Client disconnected. If we never sent headers, nothing to do.
                // If we did, just clean up. Tolerated boundary variance — but
                // never silent: leave a trace identifying which stream died.
                logger.debug(`Stream aborted: ${err.message || 'aborted by client'}`, opMeta, 'StreamHandler');
            } else {
                logFailure({
                    logger,
                    component: 'StreamHandler',
                    message: err.message,
                    meta: { ...opMeta, type: err.type, code: err.code }
                });
                if (!headersSent) {
                    // Never started the SSE stream — re-throw so the caller can
                    // respond with a proper HTTP error status + JSON body. This
                    // is the path that fixes Copilot's "Response contained no
                    // choices": the upstream fetch failed before any content,
                    // so we surface it as a real HTTP error instead of a 200 OK
                    // SSE stream carrying an error chunk Copilot ignores.
                    throw err;
                }
                // Headers already sent (mid-stream failure): in-band error chunk
                // is the only option. Copilot may not surface it, but the chat
                // app and other spec-aware clients will.
                if (this.isActive) {
                    this.res.write(`data: ${JSON.stringify({
                        error: {
                            message: err.message,
                            type: err.type || 'stream_error',
                            code: err.code || 'STREAM_ERROR',
                            ...(err.retryAfter != null && { retryAfter: err.retryAfter })
                        }
                    })}\n\n`);
                }
            }
        } finally {
            this.cleanup();
            if (headersSent && !this.res.writableEnded) {
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

}
