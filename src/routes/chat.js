import { StreamHandler } from '../streaming/sse.js';
import { getLogger } from '../utils/logger.js';
import { isAbortError } from '../utils/http.js';
import { normalizeResponse } from '../utils/response-normalizer.js';
import { describeClient } from '../utils/client-identity.js';
import { logFailure } from '../utils/failure-log.js';

const logger = getLogger();

function bindRequestAbortController(req, res) {
    const controller = new AbortController();

    const cleanup = () => {
        req.off('aborted', abort);
        res.off('close', onClose);
        res.off('finish', cleanup);
    };

    const abort = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
        cleanup();
    };

    const onClose = () => {
        if (!res.writableEnded) {
            abort();
            return;
        }
        cleanup();
    };

    req.once('aborted', abort);
    res.once('close', onClose);
    res.once('finish', cleanup);

    return controller;
}

// Upstream attempts allowed when an attempt produces nothing usable.
// Free/shared endpoints (OpenRouter's stealth slot among them) fail in bursts:
// a 200 SSE stream carrying an error frame, an empty body, or a stream that
// reasons and stops without ever emitting an answer. The same request usually
// succeeds on the next try, so one bad attempt should not become the client's
// problem. See `streamWithRetry` for why re-running is safe.
const UPSTREAM_ATTEMPTS = 3;
const UPSTREAM_RETRY_DELAY_MS = 400;

/**
 * Did this chunk carry output the client can use? Mirrors the content rule in
 * sse.js, minus reasoning: reasoning alone is not an answer, so a stream that
 * only thinks still counts as a failed attempt and is worth retrying.
 */
function hasUsableOutput(chunk) {
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return false;
    return (typeof delta.content === 'string' && delta.content.length > 0)
        || delta.tool_calls != null
        || delta.function_call != null;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run a streaming attempt, retrying while the upstream produces nothing usable.
 *
 * Safe because nothing has been committed yet: every mode emits `delta.content`
 * or `delta.tool_calls` before the client sees anything, and sse.js withholds
 * all frames until the first content chunk. So an attempt that fails before
 * that point can be discarded and re-run without the client noticing — the same
 * property that lets a pre-content failure become a real HTTP error status.
 *
 * Once an attempt commits, later failures are rethrown untouched: the stream is
 * already flowing and there is nothing to retry into.
 *
 * `makeAttempt` must return a fresh `{ generator, context, meta }` — a generator
 * is single-use, so each attempt needs its own.
 *
 * Retries stop on a 4xx: a rejected request will be rejected again, so those
 * pass through untouched rather than burning attempts.
 */
async function* streamWithRetry(makeAttempt, onAttempt) {
    let lastError = null;

    for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt++) {
        const buffered = [];
        let committed = false;

        try {
            const result = await makeAttempt();

            if (result?.stream !== true || !result?.generator) {
                const err = new Error('[ChatRoute] Invalid streaming response: expected { stream: true, generator }');
                err.status = 500;
                throw err;
            }

            onAttempt(result, attempt);

            for await (const chunk of result.generator) {
                if (committed) {
                    yield chunk;
                    continue;
                }
                buffered.push(chunk);
                if (hasUsableOutput(chunk)) {
                    committed = true;
                    for (const held of buffered) yield held;
                    buffered.length = 0;
                }
            }

            if (committed) return;

            // Stream finished cleanly but produced no answer the client can use.
            const err = new Error('Upstream produced no content.');
            err.code = 'ZERO_CONTENT';
            err.type = 'zero_content_error';
            lastError = err;
        } catch (err) {
            // Mid-stream failures cannot be retried — the client already has
            // chunks. Anything after this point is the caller's to report.
            if (committed || isAbortError(err)) throw err;
            // A rejected request stays rejected; retrying would only delay it.
            if (err.status >= 400 && err.status < 500) throw err;
            lastError = err;
        }

        if (attempt < UPSTREAM_ATTEMPTS) {
            logger.warn(
                `Upstream attempt ${attempt}/${UPSTREAM_ATTEMPTS} produced nothing usable — retrying`,
                { reason: lastError?.message, code: lastError?.code },
                'ChatRoute'
            );
            await delay(UPSTREAM_RETRY_DELAY_MS * attempt);
        }
    }

    throw lastError;
}

export function createChatHandler(router, ticketRegistry) {
    return async (req, res, next) => {
        try {
            const isAsync = String(req.headers['x-async'] || '').toLowerCase() === 'true';
            const sessionId = req.headers['x-session-id'] || null;
            const isStream = req.body.stream === true;
            // Who this request belongs to. Carried into every failure line for the
            // request, so an incident names the client instead of arriving anonymous.
            const client = describeClient(req);
            const abortController = !isAsync ? bindRequestAbortController(req, res) : null;
            const requestBody = abortController
                ? { ...req.body, signal: abortController.signal, sessionId }
                : { ...req.body, sessionId };

            // Handle streaming
            if (isStream && !isAsync) {
                const streamHandler = new StreamHandler(res);
                // NOTE: start() is NOT called here. StreamHandler.process() defers
                // flushing SSE headers until the first content chunk is ready. This
                // keeps the HTTP response mutable so that if the upstream fetch
                // fails before producing any content, we can respond with a proper
                // HTTP error status + JSON body (which Copilot surfaces clearly)
                // instead of a 200 OK SSE stream carrying an error chunk that
                // Copilot ignores → "Response contained no choices."

                let result;
                const _streamStart = Date.now();
                logger.debug('Stream start', { model: req.body?.model, msgCount: req.body?.messages?.length, streamId: _streamStart }, 'ChatRoute');
                try {
                    // Mutable holders, not snapshots: sse.js reads them lazily
                    // (context at chunk time, meta when it logs), so a retried
                    // attempt still reports its own model/adapter and context.
                    const attemptState = { context: {}, meta: { client } };

                    const generator = streamWithRetry(
                        () => router.routeChatCompletion(requestBody),
                        (attemptResult, attempt) => {
                            result = attemptResult;
                            Object.assign(attemptState.context, attemptResult.context ?? {});
                            Object.assign(attemptState.meta, attemptResult.meta ?? {});
                            if (attempt > 1) {
                                logger.debug('Stream attempt', { model: req.body?.model, attempt, streamId: _streamStart }, 'ChatRoute');
                            }
                        }
                    );

                    await streamHandler.process(generator, attemptState.context, attemptState.meta);
                    logger.debug('Stream end', { model: req.body?.model, durationMs: Date.now() - _streamStart, streamId: _streamStart }, 'ChatRoute');
                } catch (err) {
                    if (isAbortError(err)) {
                        logger.debug('Streaming request aborted by client', {}, 'ChatRoute');
                        return;
                    }
                    // If SSE headers were never flushed, respond with a proper
                    // HTTP error. This is the path that surfaces upstream fetch
                    // failures / zero-content as a real error to Copilot.
                    if (!res.headersSent) {
                        const status = err.status || 502;
                        return res.status(status).json({
                            error: {
                                message: err.message,
                                type: err.type || 'upstream_error',
                                code: err.code || 'UPSTREAM_ERROR',
                                ...(result?.meta || {}),
                                ...(err.retryAfter != null && { retryAfter: err.retryAfter })
                            }
                        });
                    }
                    // Headers already sent (mid-stream failure): emit in-band
                    // SSE error chunk as a last resort.
                    const errorResponse = {
                        error: {
                            message: err.message,
                            type: err.type || 'internal_error',
                            code: err.code || 'INTERNAL_ERROR',
                            ...(result?.meta || {}),
                            ...(err.retryAfter != null && { retryAfter: err.retryAfter })
                        }
                    };
                    streamHandler.end(errorResponse);
                }
                return;
            }

            // Handle async requests (X-Async: true ticket flow)
            if (isAsync) {
                const ticket = ticketRegistry.createTicket(1);
                ticketRegistry.updateTicketStatus(ticket.id, 'processing');

                setImmediate(async () => {
                    try {
                        const result = await router.routeChatCompletion({ ...req.body, sessionId });

                        if (result.stream) {
                            // Stream through ticket
                            for await (const chunk of result.generator) {
                                ticketRegistry.addEvent(ticket.id, { type: 'chunk', data: chunk });
                            }
                            ticketRegistry.addEvent(ticket.id, { type: 'done', data: {} });
                            ticketRegistry.updateTicketStatus(ticket.id, 'complete', {
                                result: { stream: true, context: result.context }
                            });
                        } else {
                            ticketRegistry.updateTicketStatus(ticket.id, 'complete', { result });
                        }
                    } catch (error) {
                        // An async ticket has no SSE handler to log for it, so the
                        // failure has to be recorded here or it leaves no trace at all
                        // — the client only ever sees a ticket that says "failed".
                        logFailure({
                            logger,
                            component: 'ChatRoute',
                            message: error.message,
                            meta: {
                                model: req.body?.model,
                                type: error.type,
                                code: error.code,
                                ticket: ticket.id,
                                client
                            }
                        });
                        ticketRegistry.updateTicketStatus(ticket.id, 'failed', { error });
                    }
                });

                return res.status(202).json({
                    object: 'chat.completion.task',
                    ticket: ticket.id,
                    status: 'accepted',
                    stream_url: `/v1/tasks/${ticket.id}/stream`
                });
            }

            // Regular non-streaming request
            const result = await router.routeChatCompletion(requestBody);
            const { context, ...response } = result;
            const normalized = normalizeResponse(response);

            // Upstream provider's actual usage numbers pass through unchanged.
            // Client accumulates token counts itself across the conversation.

            res.status(200).json(normalized);

        } catch (err) {
            if (isAbortError(err)) {
                logger.debug('Request aborted by client', {}, 'ChatRoute');
                return;
            }
            next(err);
        }
    };
}
