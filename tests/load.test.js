import { expect } from 'chai';
import http from 'http';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('Phase 9: Load Testing & Memory Bounds', function () {
    this.timeout(120000); // 2 minutes

    let app;
    let server;
    let config;
    const PORT = 3500;

    // We will start a fake upstream provider that streams extremely fast and large chunks
    // to simulate a heavy workload, so we can reliably trigger backpressure.
    let fakeUpstreamServer;
    const UPSTREAM_PORT = 3501;

    before(async () => {
        // 1. Setup Fake Upstream Provider to blast data
        fakeUpstreamServer = http.createServer((req, res) => {
            console.log(`[FakeUpstream] Received request: ${req.method} ${req.url}`);
            if (req.url.includes('/chat/completions')) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                let chunkCount = 0;
                // Blast 10000 huge chunks as fast as possible to overwhelm the gateway
                // each chunk contains ~5KB of text
                const chunkContent = "A".repeat(5120);
                
                const blast = () => {
                    let canWrite = true;
                    while (chunkCount < 10000 && canWrite) {
                        chunkCount++;
                        const payload = {
                            id: 'chatcmpl-fake',
                            object: 'chat.completion.chunk',
                            created: Date.now(),
                            model: 'fake-model',
                            choices: [{
                                index: 0,
                                delta: { content: chunkContent, role: 'assistant' },
                                finish_reason: null
                            }]
                        };
                        canWrite = res.write(`data: ${JSON.stringify(payload)}\n\n`);
                    }

                    if (chunkCount < 10000) {
                        res.once('drain', blast);
                    } else {
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                };
                
                blast();
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        await new Promise(resolve => fakeUpstreamServer.listen(UPSTREAM_PORT, resolve));

        // 2. Setup Gateway Config with Fake Provider
        config = await loadConfig();
        config.providers.load_tester = {
            type: 'openai',
            endpoint: `http://localhost:${UPSTREAM_PORT}`,
            apiKey: 'fake-key',
            model: 'fake-model',
            capabilities: {
                embeddings: false,
                structuredOutput: false,
                streaming: true
            }
        };

        // Increase threshold to avoid circuit breaker tripping during heavy load
        config.concurrency = config.concurrency || {};
        config.concurrency.defaultMaxConcurrent = 100;
        config.concurrency.defaultQueueDepth = 1000;

        app = createServer(config);
        server = http.createServer(app);
        await new Promise(resolve => server.listen(PORT, resolve));
    });

    after(() => {
        server.close();
        fakeUpstreamServer.close();
    });

    it('should trigger node backpressure and maintain stable memory usage', async () => {
        const initialMemory = process.memoryUsage();
        console.log(`\n[LoadTest] Initial Heap Used: ${Math.round(initialMemory.heapUsed / 1024 / 1024)} MB`);

        // We will make 20 concurrent requests to the gateway.
        // The clients will READ VERY SLOWLY to force backpressure back to the StreamHandler.
        
        const requests = Array.from({ length: 20 }).map((_, i) => {
            return new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: 'localhost',
                    port: PORT,
                    path: '/v1/chat/completions',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-provider': 'load_tester'
                    }
                }, async (res) => {
                    let totalDeliveredBytes = 0;
                    
                    if (res.statusCode !== 200) {
                        console.error(`Status ${res.statusCode}: `, res.headers);
                    }
                    
                    try {
                        let chunksReceived = 0;
                        for await (const chunk of res) {
                            totalDeliveredBytes += chunk.length;
                            chunksReceived++;
                            // sleep occasionally to simulate a slightly slow client
                            if (chunksReceived % 50 === 0) {
                                await new Promise(r => setTimeout(r, 1));
                            }
                        }
                        console.log(`[Client] Finished reading stream. Received ${chunksReceived} chunks.`);
                        resolve(totalDeliveredBytes);
                    } catch (err) {
                        reject(err);
                    }
                });

                req.on('error', reject);
                
                req.write(JSON.stringify({
                    model: 'fake-model',
                    messages: [{ role: 'user', content: 'test load' }],
                    stream: true
                }));
                req.end();
            });
        });

        // Track memory during the slow drain
        let maxHeapUsed = initialMemory.heapUsed;
        let maxRss = initialMemory.rss;
        const memoryMonitor = setInterval(() => {
            const memory = process.memoryUsage();
            if (memory.heapUsed > maxHeapUsed) maxHeapUsed = memory.heapUsed;
            if (memory.rss > maxRss) maxRss = memory.rss;
        }, 50);

        try {
            const results = await Promise.all(requests);
            clearInterval(memoryMonitor);
            
            const finalMemory = process.memoryUsage();
            console.log(`[LoadTest] Max Heap Used During Test: ${Math.round(maxHeapUsed / 1024 / 1024)} MB`);
            console.log(`[LoadTest] Max RSS During Test: ${Math.round(maxRss / 1024 / 1024)} MB`);
            console.log(`[LoadTest] Final Heap Used: ${Math.round(finalMemory.heapUsed / 1024 / 1024)} MB`);
            
            // Log total bytes delivered across all clients to ensure data moved
            const totalBytes = results.reduce((sum, bytes) => sum + bytes, 0);
            console.log(`[LoadTest] Total Data Delivered: ${Math.round(totalBytes / 1024 / 1024)} MB`);

            // Verify memory didn't explode wildly (e.g., > 100MB consumed for the streams just buffering).
            // Since we await `drain` in our StreamHandler, Node manages memory reasonably.
            const heapDiffTokens = (maxHeapUsed - initialMemory.heapUsed) / 1024 / 1024;
            
            // Allow some overhead, but it shouldn't grow boundless
            expect(heapDiffTokens).to.be.lessThan(250); // 250 MB max allowed spike roughly
            
        } catch (error) {
            clearInterval(memoryMonitor);
            throw error;
        }
    });
});
