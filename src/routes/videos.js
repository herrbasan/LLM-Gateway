import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export function createVideosHandler(router) {
    return async (req, res, next) => {
        try {
            const isAsync = String(req.headers['x-async'] || '').toLowerCase() === 'true';

            if (isAsync) {
                logger.warn('Async video generation not yet implemented in v2, handling synchronously', {}, 'VideosRoute');
            }

            const result = await router.routeVideoGeneration(req.body);
            return res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
