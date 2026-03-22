import { StreamHandler } from '../streaming/sse.js';
import { getLogger } from '../utils/logger.js';
import { isAbortError } from '../utils/http.js';

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
            const isStream = req.body.stream === true;
            const abortController = !isAsync ? bindRequestAbortController(req, res) : null;
            const requestBody = abortController
                ? { ...req.body, signal: abortController.signal }
                : req.body;

            // Handle streaming
            if (isStream && !isAsync) {
                const streamHandler = new StreamHandler(res, null, null, null);
                streamHandler.start();

                try {
                    const result = await router.routeChatCompletion(requestBody);
                    
                    if (result.stream) {
                        const globalThinkingConfig = router.registry.getThinkingConfig();
                        const clientStrip = requestBody.strip_thinking === true || requestBody.no_thinking === true;
                        const shouldStripThinking = clientStrip || globalThinkingConfig.enabled;
                        await streamHandler.process(
                            result.generator,
                            result.context,
                            shouldStripThinking,
                            globalThinkingConfig
                        );
                    } else {
                        // Non-streaming result but streaming was requested
                        streamHandler.end(result);
                    }
                } catch (err) {
                    if (isAbortError(err)) {
                        logger.info('Streaming request aborted by client', {}, 'ChatRoute');
                        return;
                    }
                    streamHandler.error(err);
                }
                return;
            }

            // Handle async requests with compaction
            if (isAsync) {
                const ticket = ticketRegistry.createTicket(1);
                ticketRegistry.updateTicketStatus(ticket.id, 'processing');

                setImmediate(async () => {
                    try {
                        const result = await router.routeChatCompletion(req.body);
                        
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
            res.status(200).json(result);

        } catch (err) {
            if (isAbortError(err)) {
                logger.info('Request aborted by client', {}, 'ChatRoute');
                return;
            }
            next(err);
        }
    };
}
