export function createImagesHandler(router) {
    return async (req, res, next) => {
        try {
            const result = await router.routeImageGeneration(req.body, req.headers);

            if (result?.isAsyncTicket) {
                return res.status(202).json(result.ticketData);
            }

            return res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
