export function createModelsHandler(router) {
    return async (req, res, next) => {
        try {
            const type = req.query.type;
            const result = await router.listModels(type);
            res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
