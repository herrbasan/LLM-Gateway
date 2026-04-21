import { StreamHandler } from '../streaming/sse.js';
import { getLogger } from '../utils/logger.js';
import { isAbortError } from '../utils/http.js';
import { normalizeResponse } from '../utils/response-normalizer.js';

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
            const isAsync = String(req.headers['x-async'] || '').toLowerCase() === 'true';
            const sessionId = req.headers['x-session-id'] || null;
            const isStream = req.body.stream === true;
            const abortController = !isAsync ? bindRequestAbortController(req, res) : null;
            const requestBody = abortController
                ? { ...req.body, signal: abortController.signal, sessionId }
                : { ...req.body, sessionId };

            // Handle streaming
            if (isStream && !isAsync) {
                const streamHandler = new StreamHandler(res);
                streamHandler.start();

                try {
                    const result = await router.routeResponse(requestBody);

                    if (result?.stream === true && result?.generator) {
                        const globalThinkingConfig = router.registry.getThinkingConfig();
                        const clientStrip = requestBody.strip_thinking === true || requestBody.no_thinking === true;
                        const shouldStripThinking = clientStrip || globalThinkingConfig.enabled;
                        await streamHandler.process(
                            result.generator,
                            result.context,
                            shouldStripThinking,
                            globalThinkingConfig,
                            requestBody.stream_options
                        );
                    } else {
                        const err = new Error('[ResponsesRoute] Invalid streaming response: expected { stream: true, generator }');
                        err.status = 500;
                        const errorResponse = { error: { message: err.message, type: 'internal_error', code: 'INVALID_RESPONSE' } };
                        streamHandler.end(errorResponse);
                    }
                } catch (err) {
                    if (isAbortError(err)) {
                        logger.info('Streaming request aborted by client', {}, 'ResponsesRoute');
                        return;
                    }
                    const errorResponse = { error: { message: err.message, type: 'internal_error', code: err.code || 'INTERNAL_ERROR' } };
                    streamHandler.end(errorResponse);
                }
                return;
            }

            // Regular non-streaming request
            const result = await router.routeResponse(requestBody);
            const { context, ...response } = result;
            const normalized = normalizeResponse(response);
            res.status(200).json(normalized);

        } catch (err) {
            if (isAbortError(err)) {
                logger.info('Request aborted by client', {}, 'ResponsesRoute');
                return;
            }
            next(err);
        }
    };
}
