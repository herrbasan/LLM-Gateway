import { StreamHandler } from '../streaming/sse.js';

export function createTasksHandler(ticketRegistry) {
    return async (req, res, next) => {
        try {
            const id = req.params.id;
            const ticket = ticketRegistry.getTicket(id);
            if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

            if (!ticket.first_polled_at) {
                ticket.first_polled_at = Date.now();
                const ageMs = ticket.first_polled_at - ticket.created_at;
                console.log(`[Tasks] async_ticket_age_before_poll=${ageMs}ms ticket=${ticket.id}`);
            }

            const response = {
                object: 'chat.completion.task',
                ticket: ticket.id,
                status: ticket.status,
                estimated_chunks: ticket.estimated_chunks,
                stream_url: `/v1/tasks/${ticket.id}/stream`
            };

            if (ticket.status === 'complete' && ticket.result) {
                response.result = ticket.result;
            }

            if (ticket.status === 'failed' && ticket.error) {
                response.error = ticket.error.message;
            }
            
            return res.status(200).json(response);
        } catch (err) {
            next(err);
        }
    };
}

export function createTasksStreamHandler(ticketRegistry) {
    return async (req, res, next) => {
        try {
            const id = req.params.id;
            const ticket = ticketRegistry.getTicket(id);
            if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

            const streamHandler = new StreamHandler(res);
            streamHandler.start();

            // Replay events
            for (const ev of ticket.events) {
                streamHandler.emitEvent(ev.type, ev.data);
            }

            if (ticket.status === 'complete' || ticket.status === 'failed') {
                if (ticket.result && ticket.result.stream === false) {
                    streamHandler.emitEvent('completion.result', ticket.result);
                } else if (ticket.error) {
                    streamHandler.emitEvent('completion.error', { error: ticket.error.message });
                }
                streamHandler.res.write('data: [DONE]\n\n');
                streamHandler.cleanup();
                streamHandler.res.end();
                return;
            }

            const unsubscribe = ticketRegistry.subscribe(id, (event) => {
                if (!streamHandler.isActive) {
                    unsubscribe();
                    return;
                }
                if (event.type === 'status_update') {
                    if (event.status === 'complete') {
                        if (event.extra.result && event.extra.result.stream === false) {
                            streamHandler.emitEvent('completion.result', event.extra.result);
                        }
                        streamHandler.res.write('data: [DONE]\n\n');
                        streamHandler.cleanup();
                        streamHandler.res.end();
                    } else if (event.status === 'failed') {
                        streamHandler.emitEvent('completion.error', { error: event.extra.error?.message });
                        streamHandler.res.write('data: [DONE]\n\n');
                        streamHandler.cleanup();
                        streamHandler.res.end();
                    }
                    unsubscribe();
                } else {
                    if (event.type === 'chunk') {
                        streamHandler.res.write(`data: ${JSON.stringify(event.data)}\n\n`);
                    } else if (event.type === 'done') {
                        streamHandler.res.write('data: [DONE]\n\n');
                        streamHandler.cleanup();
                        streamHandler.res.end();
                        unsubscribe();
                    } else {
                        streamHandler.emitEvent(event.type, event.data);
                    }
                }
            });

            req.on('close', () => {
                unsubscribe();
            });

        } catch (err) {
            next(err);
        }
    };
}
