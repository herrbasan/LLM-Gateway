import { Router } from '../core/router.js';

export function createModelsHandler(config) {
    const router = new Router(config);

    return async (req, res, next) => {
        try {
            const result = await router.routeModels(req.headers);
            res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
