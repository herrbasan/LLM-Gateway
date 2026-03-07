export function createAudioSpeechHandler(router) {
    return async (req, res, next) => {
        try {
            const result = await router.routeAudioSpeech(req.body);

            if (result?.audio) {
                const mimeType = result.mimeType || 'audio/mpeg';
                const buffer = Buffer.from(result.audio, 'base64');
                res.setHeader('Content-Type', mimeType);
                return res.status(200).send(buffer);
            }

            return res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
