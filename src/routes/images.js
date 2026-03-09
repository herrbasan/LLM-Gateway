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
            
            // Defensive: Ensure we're sending a clean copy, not a reference that could be mutated
            // This prevents any accidental mutation from logging or other side effects
            const responseData = JSON.parse(JSON.stringify(result));
            
            // Debug: Verify the response contains actual base64 data, not sanitized placeholders
            if (responseData?.data?.[0]?.b64_json?.includes('[BINARY_DATA]')) {
                logger.error('[ImagesHandler] CRITICAL: Response contains sanitized placeholder instead of actual data');
            }
            
            return res.status(200).json(responseData);
        } catch (err) {
            next(err);
        }
    };
}
