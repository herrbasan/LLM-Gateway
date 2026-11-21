import { getLogger } from '../utils/logger.js';

const logger = getLogger();

const MODEL_ID = 'wizkid-embed';
const TIMEOUT_MS = 28000;

export function createWizkidEmbeddingsHandler(router) {
    return async (req, res, next) => {
        try {
            const { config } = router.registry.resolveModel(MODEL_ID, 'embedding');
            const upstream = await fetch(`${config.endpoint}/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`
                },
                body: JSON.stringify({
                    input: req.body.input,
                    model: config.adapterModel,
                    dimensions: req.body.dimensions,
                    encoding_format: req.body.encoding_format
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });

            const text = await upstream.text();
            res.status(upstream.status);
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
            const retryAfter = upstream.headers.get('retry-after');
            if (retryAfter !== null) res.setHeader('Retry-After', retryAfter);
            res.send(text);
        } catch (err) {
            if (err.name === 'TimeoutError') {
                logger.warn('Wizkid embed proxy timed out after 28s', {}, 'WizkidEmbeddingsRoute');
                return res.status(504).json({ error: 'Embedding upstream timeout' });
            }
            logger.error(`Wizkid embed proxy failed: ${err.message}`, {}, 'WizkidEmbeddingsRoute');
            next(err);
        }
    };
}
