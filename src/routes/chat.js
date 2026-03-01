import { Router } from '../core/router.js';
import { StreamHandler } from '../streaming/sse.js';

export function createChatHandler(config, sessionStore) {
    const router = new Router(config, sessionStore);

    return async (req, res, next) => {
        try {
            const result = await router.route(req.body, req.headers);

            if (req.body.stream) {
                const streamHandler = new StreamHandler(res, sessionStore, req.headers['x-session-id']);
                await streamHandler.process(result);
            } else {
                res.status(200).json(result);
            }
        } catch (err) {
            next(err);
        }
    };
}
