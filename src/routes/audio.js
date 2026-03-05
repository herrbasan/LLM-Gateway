export function createAudioSpeechHandler(router) {
    return async (req, res, next) => {
        try {
            const result = await router.routeAudioSpeech(req.body, req.headers);

            if (result?.audioBuffer) {
                res.setHeader('Content-Type', result.contentType || 'audio/mpeg');
                return res.status(200).send(result.audioBuffer);
            }

            return res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
