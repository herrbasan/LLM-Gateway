import { camelToSnake } from '../utils/format.js';

async function formatSessionResponse(session, router) {
    let window_size = 0;
    let used_tokens = 0;
    let available_tokens = 0;

    // Fast heuristic estimation if no adapter is explicitly defined via a request
    // Typically session stats are rough until a request binds a model.
    // We'll use the default provider to estimate.
    try {
        const { adapter } = router._resolveProviderAndModel('auto');
        window_size = await adapter.getContextWindow();
        const content = session.messages.map(m => m.content).join('');
        used_tokens = await router.tokenEstimator.estimate(content, adapter);
        available_tokens = window_size - used_tokens;
    } catch (e) {
        // Ignore estimation failure
    }

    const payload = {
        session: {
            id: session.id,
            message_count: session.messages.length,
            context: {
                window_size,
                used_tokens,
                available_tokens,
                compression_count: session.compression_count || 0,
                strategy: session.strategy || 'truncate'
            }
        }
    };
    return camelToSnake(payload);
}

export function createSessionsHandler(sessionStore, router) {
    return async (req, res, next) => {
        try {
            if (req.method === 'POST') {
                const session = sessionStore.createSession(req.body || {});
                return res.status(201).json(await formatSessionResponse(session, router));
            }
            res.status(405).json({ error: 'Method Not Allowed' });
        } catch (err) {
            next(err);
        }
    };
}

export function createSessionIdHandler(sessionStore, router) {
    return async (req, res, next) => {
        try {
            const id = req.params.id;
            
            if (req.method === 'GET') {
                const session = sessionStore.getSession(id);
                if (!session) return res.status(404).json({ error: 'Session not found' });
                return res.status(200).json(await formatSessionResponse(session, router));
            }
            
            if (req.method === 'PATCH') {
                const session = sessionStore.updateSession(id, req.body || {});
                return res.status(200).json(await formatSessionResponse(session, router));
            }

            if (req.method === 'POST' && req.path.endsWith('/compress')) {
                const session = sessionStore.getSession(id);
                if (!session) return res.status(404).json({ error: 'Session not found' });
                
                const strategyArgs = req.body || {};
                const mode = strategyArgs.strategy || session.strategy || 'truncate';
                
                const { adapter } = router._resolveProviderAndModel('auto');
                const window_size = await adapter.getContextWindow();
                
                if (typeof router.contextManager[mode] === 'function') {
                    const newMessages = await router.contextManager[mode](session.messages, window_size, router.tokenEstimator, adapter, strategyArgs);
                    sessionStore.replaceMessages(id, newMessages);
                } else if (mode !== 'none') {
                    const newMessages = await router.contextManager.truncate(session.messages, window_size, router.tokenEstimator, adapter, strategyArgs);
                    sessionStore.replaceMessages(id, newMessages);
                }
                
                return res.status(200).json(await formatSessionResponse(sessionStore.getSession(id), router));
            }

            if (req.method === 'DELETE') {
                const deleted = sessionStore.deleteSession(id);
                if (!deleted) return res.status(404).json({ error: 'Session not found' });
                return res.status(204).send();
            }

            res.status(405).json({ error: 'Method Not Allowed' });
        } catch (err) {
            if (err.message === 'Session not found') {
                return res.status(404).json({ error: 'Session not found' });
            }
            next(err);
        }
    };
}
