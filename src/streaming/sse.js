export class StreamHandler {
    constructor(res, sessionStore = null, sessionId = null) {
        this.res = res;
        this.sessionStore = sessionStore;
        this.sessionId = sessionId;
        this.heartbeatInterval = null;
        this.isActive = true;
    }

    start() {
        this.res.setHeader('Content-Type', 'text/event-stream');
        this.res.setHeader('Cache-Control', 'no-cache');
        this.res.setHeader('Connection', 'keep-alive');
        this.res.flushHeaders();

        // Keep-Alives/Heartbeat: Inject `: heartbeat` comments
        this.heartbeatInterval = setInterval(() => {
            if (this.isActive) {
                this.res.write(': heartbeat\n\n');
            }
        }, 15000);

        this.res.on('close', () => {
            this.cleanup();
        });
    }

    cleanup() {
        this.isActive = false;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    async process(chunkGenerator) {
        this.start();
        let fullContent = '';
        let role = 'assistant';

        try {
            for await (const chunk of chunkGenerator) {
                if (!this.isActive) break;
                
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) fullContent += delta.content;
                if (delta?.role) role = delta.role;

                const payloadStr = `data: ${JSON.stringify(chunk)}\n\n`;

                // Handle Interceptor Backpressure: pause if client is slow compared to burst generator
                const canContinue = this.res.write(payloadStr);
                if (!canContinue) {
                    await new Promise(resolve => {
                        this.res.once('drain', resolve);
                        this.res.once('close', resolve);
                        this.res.once('error', resolve);
                    });
                }
            }

            if (this.isActive) {
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
