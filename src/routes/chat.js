import { StreamHandler } from '../streaming/sse.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export function createChatHandler(router, ticketRegistry) {
    return async (req, res, next) => {
        try {
            const isAsync = String(req.headers['x-async'] || '').toLowerCase() === 'true';
            const isStream = req.body.stream === true;

            // Handle streaming
            if (isStream && !isAsync) {
                const streamHandler = new StreamHandler(res, null, null, null);
                streamHandler.start();

                try {
                    const result = await router.routeChatCompletion(req.body);
                    
                    if (result.stream) {
                        const thinkingConfig = router.registry.getThinkingConfig();
                        await streamHandler.process(
                            result.generator,
                            result.context,
                            thinkingConfig.enabled,
                            thinkingConfig
                        );
                    } else {
                        // Non-streaming result but streaming was requested
                        streamHandler.end(result);
                    }
                } catch (err) {
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
            const result = await router.routeChatCompletion(req.body);
            res.status(200).json(result);

        } catch (err) {
            next(err);
        }
    };
}
