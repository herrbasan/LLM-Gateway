import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// ============================================
// Embeddings — thin proxy to the Fatten wrapper
//
// The gateway owns the model. Clients send { input, dimensions } only.
// The wrapper (llama-cpp-server) handles queueing and disconnect semantics.
//
// This mirrors mcp_server/src/embed-client.js exactly: a simple fetch
// with AbortSignal.timeout. No res.on('close') — that was causing
// premature aborts in Express's response lifecycle. The timeout is the
// only safety net, same as the MCP server's proven pattern.
// ============================================

const EMBED_WRAPPER_URL = 'http://192.168.0.145:4080/v1/embeddings';
const EMBED_MODEL = 'Qwen/Qwen3-Embedding-4B-GGUF';
const EMBED_TIMEOUT_MS = 120000;

export function createEmbeddingsHandler() {
    return async (req, res, next) => {
        try {
            const upstream = await fetch(EMBED_WRAPPER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input: req.body.input,
                    model: EMBED_MODEL,
                    dimensions: req.body.dimensions
                }),
                signal: AbortSignal.timeout(EMBED_TIMEOUT_MS)
            });

            const text = await upstream.text();

            res.status(upstream.status);
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
            res.send(text);
        } catch (err) {
            if (err.name === 'TimeoutError') {
                logger.warn(`Embed proxy timed out after ${EMBED_TIMEOUT_MS / 1000}s`, {}, 'EmbeddingsRoute');
                return res.status(504).json({ error: 'Embedding upstream timeout' });
            }
            logger.error(`Embed proxy failed: ${err.message}`, {}, 'EmbeddingsRoute');
            next(err);
        }
    };
}
