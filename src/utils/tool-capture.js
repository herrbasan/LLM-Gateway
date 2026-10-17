import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger } from './logger.js';

const logger = getLogger();

/**
 * Capture the tool-schema sets clients actually send, to grow the conformance corpus.
 *
 * Every schema bug that ended a session in 2026 came from a real client payload that
 * no test had ever seen. Hand-written fixtures only cover what we thought of; real
 * traffic covers what clients actually do.
 *
 * Off unless `CAPTURE_TOOLS_DIR` is set. Only the tools array is written — never
 * message content, which carries user words. Deduplicated per process, because the
 * same tool set is resent on every turn of a conversation.
 *
 * Point it at a scratch directory (`logs/tool-fixtures`), then move the interesting
 * files into `tests/fixtures/client-tools/` and the conformance suite picks them up.
 */
const target = process.env.CAPTURE_TOOLS_DIR || null;
const written = new Set();

export function captureToolSchemas(modelId, tools) {
    if (!target || !Array.isArray(tools) || tools.length === 0) return;

    const payload = { source: `captured from ${modelId}`, tools };
    const json = JSON.stringify(payload);
    const hash = createHash('sha256').update(json).digest('hex').slice(0, 12);
    if (written.has(hash)) return;
    written.add(hash);

    try {
        fs.mkdirSync(target, { recursive: true });
        const file = path.join(target, `${modelId.replace(/[^a-z0-9._-]/gi, '_')}-${hash}.json`);
        fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
        logger.info('Captured a tool-schema set for the conformance corpus', {
            model: modelId,
            file,
            tools: tools.length
        }, 'ToolCapture');
    } catch (error) {
        // Capture is diagnostics: a failure must be visible, never silent.
        logger.warn('Tool-schema capture failed', { error: error.message, dir: target }, 'ToolCapture');
    }
}
