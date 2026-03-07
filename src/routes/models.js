export function createModelsHandler(router) {
    return async (req, res, next) => {
        try {
            const result = await router.listModels();
            res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
