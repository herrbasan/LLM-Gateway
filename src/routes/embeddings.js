export function createEmbeddingsHandler(router) {
    return async (req, res, next) => {
        try {
            const result = await router.routeEmbedding(req.body);
            res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
