import { createThinkingStripper } from '../utils/format.js';

export class StreamHandler {
    constructor(res, sessionStore = null, sessionId = null, config = {}) {
        this.res = res;
        this.sessionStore = sessionStore;
        this.sessionId = sessionId;
        this.config = config;
        this.heartbeatIntervalMs = config.compaction?.heartbeatIntervalMs || 15000;
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

        // Keep-Alives/Heartbeat: Inject `: heartbeat` comments
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

    cleanup() {
        this.isActive = false;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    async process(chunkGenerator, contextPayload = null, stripThinking = false, thinkingConfig = undefined) {
        this.start();
        let fullContent = '';
        let role = 'assistant';
        
        // Create thinking stripper if enabled
        const thinkingStripper = stripThinking ? createThinkingStripper(thinkingConfig) : null;

        try {
            for await (const chunk of chunkGenerator) {
                if (!this.isActive) break;
                
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) {
                    let content = delta.content;
                    
                    // Strip thinking content if configured
                    if (thinkingStripper) {
                        content = thinkingStripper.process(content);
                        // Update chunk with stripped content
                        chunk.choices[0].delta.content = content;
                    }
                    
                    // Prevent memory exhaustion attacks on session storage
                    // Usually 128K tokens is < 500KB. We clamp at 5MB as an absolute safety bound.
                    if (fullContent.length < 5 * 1024 * 1024) {
                        fullContent += content;
                    }
                }
                if (delta?.role) role = delta.role;

                const payloadStr = `data: ${JSON.stringify(chunk)}\n\n`;

                // Handle Interceptor Backpressure: pause if client is slow compared to burst generator
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
                if (remaining && fullContent.length < 5 * 1024 * 1024) {
                    fullContent += remaining;
                }
            }

            if (this.isActive) {
                if (contextPayload) {
                    this.res.write(`event: context.status\ndata: ${JSON.stringify(contextPayload)}\n\n`);
                }
                this.res.write('data: [DONE]\n\n');
            }
        } catch (err) {
            console.error('[StreamHandler] Streaming error:', err);
            if (this.isActive) {
                // OpenAI standard doesn't strictly define an inline error chunk format,
                // but ending the connection is standard proxy behavior on failure.
            }
        } finally {
            this.cleanup();
            if (!this.res.writableEnded) {
                this.res.end();
            }
            if (this.sessionId && this.sessionStore && fullContent) {
                 this.sessionStore.appendMessages(this.sessionId, [{ role, content: fullContent }]);
            }
        }
    }
}
