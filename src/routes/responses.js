import { getLogger } from '../utils/logger.js';
import { isAbortError } from '../utils/http.js';

const logger = getLogger();

function bindRequestAbortController(req, res) {
    const controller = new AbortController();

    const cleanup = () => {
        req.off('aborted', abort);
        res.off('close', onClose);
        res.off('finish', cleanup);
    };

    const abort = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
        cleanup();
    };

    const onClose = () => {
        if (!res.writableEnded) {
            abort();
            return;
        }
        cleanup();
    };

    req.once('aborted', abort);
    res.once('close', onClose);
    res.once('finish', cleanup);

    return controller;
}

export function createResponsesHandler(router, ticketRegistry) {
    return async (req, res, next) => {
        try {
            const isStream = req.body.stream === true;
            const abortController = bindRequestAbortController(req, res);
            const requestBody = { ...req.body, signal: abortController.signal };

            if (isStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                const heartbeat = setInterval(() => {
                    if (!res.writableEnded) res.write(': heartbeat\n\n');
                }, 15000);

                try {
                    const result = await router.routeResponse(requestBody);

                    if (result?.stream && result?.generator) {
                        const isNative = result._format === 'responses-native';

                        for await (const event of result.generator) {
                            if (res.writableEnded) break;

                            if (isNative && event.provider === 'openai') {
                                res.write(`data: ${JSON.stringify(event)}\n\n`);
                                continue;
                            }

                            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                        }
                    }

                    if (!res.writableEnded) {
                        res.write('data: [DONE]\n\n');
                    }
                } catch (err) {
                    if (isAbortError(err)) {
                        logger.info('Streaming responses request aborted by client', {}, 'ResponsesRoute');
                        return;
                    }
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'internal_error', code: err.code || 'INTERNAL_ERROR' } })}\n\n`);
                    }
                } finally {
                    clearInterval(heartbeat);
                    if (!res.writableEnded) res.end();
                }
                return;
            }

            const result = await router.routeResponse(requestBody);
            const { context, ...response } = result;
            res.status(200).json(response);

        } catch (err) {
            if (isAbortError(err)) {
                logger.info('Request aborted by client', {}, 'ResponsesRoute');
                return;
            }
            next(err);
        }
    };
}
