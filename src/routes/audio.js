/**
 * Convert PCM audio to WAV format for browser playback.
 * Assumes 16-bit signed PCM, 24000Hz, mono (Gemini TTS format).
 */
function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcmBuffer.length;
    const wavSize = 44 + dataSize;
    
    const wavBuffer = Buffer.alloc(wavSize);
    let offset = 0;
    
    // RIFF chunk descriptor
    wavBuffer.write('RIFF', offset); offset += 4;
    wavBuffer.writeUInt32LE(wavSize - 8, offset); offset += 4;
    wavBuffer.write('WAVE', offset); offset += 4;
    
    // fmt sub-chunk
    wavBuffer.write('fmt ', offset); offset += 4;
    wavBuffer.writeUInt32LE(16, offset); offset += 4; // Subchunk1Size
    wavBuffer.writeUInt16LE(1, offset); offset += 2;  // AudioFormat (PCM)
    wavBuffer.writeUInt16LE(channels, offset); offset += 2;
    wavBuffer.writeUInt32LE(sampleRate, offset); offset += 4;
    wavBuffer.writeUInt32LE(byteRate, offset); offset += 4;
    wavBuffer.writeUInt16LE(blockAlign, offset); offset += 2;
    wavBuffer.writeUInt16LE(bitsPerSample, offset); offset += 2;
    
    // data sub-chunk
    wavBuffer.write('data', offset); offset += 4;
    wavBuffer.writeUInt32LE(dataSize, offset); offset += 4;
    
    // PCM data
    pcmBuffer.copy(wavBuffer, offset);
    
    return wavBuffer;
}

export function createAudioSpeechHandler(router) {
    return async (req, res, next) => {
        try {
            const result = await router.routeAudioSpeech(req.body);

            if (result?.audio) {
                let mimeType = result.mimeType || 'audio/mpeg';
                
                // Handle both base64 string and Buffer/Uint8Array
                let buffer;
                if (Buffer.isBuffer(result.audio)) {
                    buffer = result.audio;
                } else if (typeof result.audio === 'string') {
                    buffer = Buffer.from(result.audio, 'base64');
                } else {
                    buffer = Buffer.from(result.audio);
                }
                
                // Convert PCM to WAV for browser playback
                if (mimeType.includes('pcm') || mimeType.includes('L16')) {
                    buffer = pcmToWav(buffer, 24000, 1, 16);
                    mimeType = 'audio/wav';
                }
                
                res.setHeader('Content-Type', mimeType);
                return res.status(200).send(buffer);
            }

            return res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    };
}
