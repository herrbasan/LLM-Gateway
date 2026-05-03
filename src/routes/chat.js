import { StreamHandler } from '../streaming/sse.js';
import { getLogger } from '../utils/logger.js';
import { isAbortError } from '../utils/http.js';
import { normalizeResponse } from '../utils/response-normalizer.js';

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

export function createChatHandler(router, ticketRegistry) {
    return async (req, res, next) => {
        try {
            const isAsync = String(req.headers['x-async'] || '').toLowerCase() === 'true';
            const sessionId = req.headers['x-session-id'] || null;
            const isStream = req.body.stream === true;
            const abortController = !isAsync ? bindRequestAbortController(req, res) : null;
            const requestBody = abortController
                ? { ...req.body, signal: abortController.signal, sessionId }
                : { ...req.body, sessionId };

            // Handle streaming
            if (isStream && !isAsync) {
                const streamHandler = new StreamHandler(res);
                streamHandler.start();

                try {
                    const result = await router.routeChatCompletion(requestBody);

                    if (result?.stream === true && result?.generator) {
                        const clientStrip = requestBody.strip_thinking === true || requestBody.no_thinking === true;
                        await streamHandler.process(
                            result.generator,
                            result.context,
                            clientStrip,
                            undefined,
                            requestBody.stream_options
                        );
                    } else {
                        const err = new Error('[ChatRoute] Invalid streaming response: expected { stream: true, generator }');
                        err.status = 500;
                        const errorResponse = { error: { message: err.message, type: 'internal_error', code: 'INVALID_RESPONSE' } };
                        streamHandler.end(errorResponse);
                    }
                } catch (err) {
                    if (isAbortError(err)) {
                        logger.info('Streaming request aborted by client', {}, 'ChatRoute');
                        return;
                    }
                    const errorResponse = { error: { message: err.message, type: 'internal_error', code: err.code || 'INTERNAL_ERROR' } };
                    streamHandler.end(errorResponse);
                }
                return;
            }

            // Handle async requests with compaction
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
            res.status(200).json(normalized);

        } catch (err) {
            if (isAbortError(err)) {
                logger.info('Request aborted by client', {}, 'ChatRoute');
                return;
            }
            next(err);
        }
    };
}
