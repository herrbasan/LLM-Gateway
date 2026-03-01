import { Router } from '../core/router.js';

export function createEmbeddingsHandler(config) {
    const router = new Router(config);

    return async (req, res, next) => {
        try {
            const result = await router.routeEmbeddings(req.body, req.headers);
            res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
