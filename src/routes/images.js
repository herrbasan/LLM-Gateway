import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export function createImagesHandler(router) {
    return async (req, res, next) => {
        try {
            const isAsync = String(req.headers['x-async'] || '').toLowerCase() === 'true';

            if (isAsync) {
                // Async handling through ticket registry would need to be added
                // For now, handle synchronously
                logger.warn('Async image generation not yet implemented in v2, handling synchronously', {}, 'ImagesRoute');
            }

            const result = await router.routeImageGeneration(req.body);

            // Fail loud if the payload was sanitized somewhere upstream — the
            // client must get a 500, not a broken [BINARY_DATA] image.
            if (result?.data?.[0]?.b64_json?.includes('[BINARY_DATA]')) {
                const err = new Error('[ImagesRoute] Response contains sanitized placeholder instead of image data');
                err.status = 500;
                throw err;
            }

            return res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
