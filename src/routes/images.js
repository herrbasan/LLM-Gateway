import { getLogger } from '../utils/logger.js';
import { describeClient } from '../utils/client-identity.js';
import { logFailure } from '../utils/failure-log.js';

const logger = getLogger();

export function createImagesHandler(router) {
    return async (req, res, next) => {
        try {
            const result = await router.routeImageGeneration(req.body);
            res.json(result);
        } catch (err) {
            const status = err.status || 500;
            if (status >= 500) {
                logFailure({
                    logger,
                    component: 'ImagesRoute',
                    message: err.message,
                    meta: { client: describeClient(req), model: req.body?.model }
                });
            } else {
                logger.warn(`Image generation rejected: ${err.message}`, { status }, 'ImagesRoute');
            }
            res.status(status).json({
                error: {
                    message: err.message,
                    type: status >= 500 ? 'upstream_error' : 'invalid_request_error',
                    code: status >= 500 ? 'UPSTREAM_ERROR' : 'INVALID_REQUEST'
                }
            });
        }
    };
}
