import { StreamHandler } from '../streaming/sse.js';

export function createChatHandler(router, sessionStore) {
    return async (req, res, next) => {
        try {
            let streamHandler = null;
            let onProgress = null;
            const isAsync = String(req.headers['x-async'] || req.headers['X-Async'] || '').toLowerCase() === 'true';

            if (req.body.stream && !isAsync) {
                streamHandler = new StreamHandler(res, sessionStore, req.headers['x-session-id'], router.config);
                streamHandler.start(); // Start SSE immediately
                onProgress = (event) => {
                    streamHandler.emitEvent(event.type, event.data);
                };
            }

            const result = await router.route(req.body, req.headers, { onProgress });

            if (result && result.isAsyncTicket) {
                return res.status(202).json(result.ticketData);
            }

            if (req.body.stream) {
                if (!streamHandler) {
                    streamHandler = new StreamHandler(res, sessionStore, req.headers['x-session-id'], router.config);
                    streamHandler.start();
                }
                const generator = result.stream ? result.generator : result;
                const context = result.stream ? result.context : null;
                await streamHandler.process(generator, context);
            } else {
                res.status(200).json(result);
            }
        } catch (err) {
            next(err);
        }
    };
}
