import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export function createImagesHandler(router) {
    return async (req, res, next) => {
        try {
            const isAsync = String(req.headers['x-async'] || '').toLowerCase() === 'true';

            if (isAsync) {
                // Async handling through ticket registry would need to be added
                // For now, handle synchronously
                logger.warn('Async image generation not yet implemented in v2, handling synchronously');
            }

            const result = await router.routeImageGeneration(req.body);
            return res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
