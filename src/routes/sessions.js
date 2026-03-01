export function createSessionsHandler(sessionStore) {
    return async (req, res, next) => {
        try {
            if (req.method === 'POST') {
                const session = sessionStore.createSession(req.body || {});
                return res.status(201).json(session);
            }
            res.status(405).json({ error: 'Method Not Allowed' });
        } catch (err) {
            next(err);
        }
    };
}

export function createSessionIdHandler(sessionStore) {
    return async (req, res, next) => {
        try {
            const id = req.params.id;
            
            if (req.method === 'GET') {
                const session = sessionStore.getSession(id);
                if (!session) return res.status(404).json({ error: 'Session not found' });
                return res.status(200).json(session);
            }
            
            if (req.method === 'PATCH') {
                const session = sessionStore.updateSession(id, req.body || {});
                return res.status(200).json(session);
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
