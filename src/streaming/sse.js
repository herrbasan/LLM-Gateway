import { createThinkingStripper } from '../utils/format.js';
import { isAbortError } from '../utils/http.js';

export class StreamHandler {
    constructor(res, options = {}) {
        this.res = res;
        this.heartbeatIntervalMs = options?.heartbeatIntervalMs || 15000;
        this.heartbeatInterval = null;
        this.isActive = true;
        this.started = false;
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.res.setHeader('Content-Type', 'text/event-stream');
        this.res.setHeader('Cache-Control', 'no-cache');
        this.res.setHeader('Connection', 'keep-alive');
        this.res.flushHeaders();

        // Keep-Alives/Heartbeat
        this.heartbeatInterval = setInterval(() => {
            if (this.isActive) {
                this.res.write(': heartbeat\n\n');
            }
        }, this.heartbeatIntervalMs);

        this.res.on('close', () => {
            this.cleanup();
        });
    }

    emitEvent(type, data) {
        if (!this.isActive) return;
        if (!this.started) this.start();
        this.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    emitDeltaEvent(chunk) {
        if (!this.isActive) return;
        if (!this.started) this.start();
        const payloadStr = `data: ${JSON.stringify(chunk)}\n\n`;
        this.res.write(payloadStr);
    }

    cleanup() {
        this.isActive = false;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    async process(chunkGenerator, contextPayload = null, stripThinking = false, thinkingConfig = undefined) {
        this.start();

        // Create thinking stripper if enabled
        const thinkingStripper = stripThinking ? createThinkingStripper(thinkingConfig) : null;

        try {
            for await (const chunk of chunkGenerator) {
                if (!this.isActive) break;

                const delta = chunk.choices?.[0]?.delta;
                if (delta) {
                    if (delta.content === null) delete delta.content;
                    if (delta.content && thinkingStripper) {
                        delta.content = thinkingStripper.process(delta.content);
                    }
                    if (stripThinking && delta.reasoning_content !== undefined) {
                        delete delta.reasoning_content;
                    }
                }

                const payloadStr = `data: ${JSON.stringify(chunk)}\n\n`;

                // Handle backpressure
                const canContinue = this.res.write(payloadStr);
                if (!canContinue) {
                    await new Promise(resolve => {
                        const cleanup = () => {
                            this.res.off('drain', resolveHandler);
                            this.res.off('close', resolveHandler);
                            this.res.off('error', resolveHandler);
                            resolve();
                        };
                        const resolveHandler = () => cleanup();

                        this.res.once('drain', resolveHandler);
                        this.res.once('close', resolveHandler);
                        this.res.once('error', resolveHandler);
                    });
                }
            }

            // Flush any remaining content from stripper buffer
            if (thinkingStripper) {
                const remaining = thinkingStripper.flush();
                if (remaining) {
                    this.res.write(`data: ${JSON.stringify({
                        choices: [{ delta: { content: remaining } }]
                    })}\n\n`);
                }
            }

            if (this.isActive) {
                if (contextPayload) {
                    this.res.write(`event: context.status\ndata: ${JSON.stringify(contextPayload)}\n\n`);
                }
                this.res.write('data: [DONE]\n\n');
            }
        } catch (err) {
            if (!isAbortError(err)) {
                console.error('[StreamHandler] Streaming error:', err);
            }
        } finally {
            this.cleanup();
            if (!this.res.writableEnded) {
                this.res.end();
            }
        }
    }

    end(data) {
        if (this.isActive) {
            this.res.write(`data: ${JSON.stringify(data)}\n\n`);
            this.res.write('data: [DONE]\n\n');
        }
        this.cleanup();
        if (!this.res.writableEnded) {
            this.res.end();
        }
    }

    error(err) {
        console.error('[StreamHandler] Error:', err);
        this.cleanup();
        if (!this.res.writableEnded) {
            this.res.end();
        }
    }
}
