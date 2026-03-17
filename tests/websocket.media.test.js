import { expect } from 'chai';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { setupWebSocketServer } from '../src/websocket/server.js';
import http from 'http';

describe('WebSocket v2 - Media Phase 6 Test', () => {
    let app;
    let server;
    let config;
    let wsSystem;
    let wsUrl;
    let wsClients = [];
    let receivedPayloads = [];

    before(async () => {
        config = await loadConfig();
        config.port = 0;
        app = createServer(config);
        server = http.createServer(app);

        const mockRouter = {
            registry: {
                resolveModel: (model) => ({ adapter: 'mock', config: { type: 'chat' } })
            },
            resolveModel: (model) => ({ adapter: 'mock' }),
            routeChatCompletion: async (request) => {
                receivedPayloads.push(request);
                return {
                    stream: true,
                    generator: (async function* () {
                        yield { choices: [{ delta: { content: 'media handled' } }] };
                    })()
                };
            }
        };

        const mockTicketRegistry = {
            createTicket: () => {}
        };

        wsSystem = setupWebSocketServer(server, app, config, {
            router: mockRouter,
            ticketRegistry: mockTicketRegistry
        });

        await new Promise(resolve => server.listen(0, resolve));
        wsUrl = `ws://127.0.0.1:${server.address().port}/v1/realtime`;
    });

    after(() => {
        wsClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });
        if (server) server.close();
    });

    beforeEach(() => {
        receivedPayloads = [];
    });

    function createClient() {
        return new Promise((resolve) => {
            const client = new WebSocket(wsUrl);
            client.once('open', () => {
                wsClients.push(client);
                resolve(client);
            });
        });
    }

    it('should handle media.start, binary chunks, and media.stop, and inject them into chat', async () => {
        const client = await createClient();
        
        let mediaUrl = null;
        let p = new Promise(resolve => {
            client.on('message', (msg) => {
                const data = JSON.parse(msg.toString());
                if (data.id === 'req-media-1' && data.result?.url) {
                    mediaUrl = data.result.url;
                    resolve();
                }
            });
        });

        // 1. Send media.start
        client.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 'req-media-1',
            method: 'media.start',
            params: {
                stream_id: 'test-img-123',
                mime_type: 'image/jpeg'
            }
        }));

        await p;
        expect(mediaUrl).to.equal('gateway-media://test-img-123');

        // 2. Send binary chunks
        const header1 = Buffer.from(JSON.stringify({ s: 'test-img-123', t: 'b', seq: 0 }), 'utf-8');
        const sep = Buffer.from([0x00]);
        const chunk1 = Buffer.from('hello', 'utf-8');
        client.send(Buffer.concat([header1, sep, chunk1]));

        const header2 = Buffer.from(JSON.stringify({ s: 'test-img-123', t: 'b', seq: 1 }), 'utf-8');
        const chunk2 = Buffer.from('world', 'utf-8');
        client.send(Buffer.concat([header2, sep, chunk2]));

        // 3. Send media.stop
        client.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 'req-media-2',
            method: 'media.stop',
            params: {
                stream_id: 'test-img-123'
            }
        }));

        // Wait a bit for stop to process
        await new Promise(resolve => setTimeout(resolve, 50));

        // 4. Send chat.create using the proxy url
        client.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 'req-chat-1',
            method: 'chat.create',
            params: {
                model: 'gemini-image',
                messages: [{ 
                    role: 'user', 
                    content: [
                        { type: 'text', text: 'describe this' }, 
                        { type: 'image_url', image_url: { url: 'gateway-media://test-img-123' } }
                    ] 
                }]
            }
        }));

        // Wait for router invocation
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(receivedPayloads).to.have.lengthOf(1);
        const request = receivedPayloads[0];
        
        expect(request.messages[0].content).to.be.an('array');
        const fileContent = request.messages[0].content.find(c => c.type === 'image_url');
        
        // The base64 encoding of 'helloworld' is 'aGVsbG93b3JsZA=='
        expect(fileContent).to.exist;
        expect(fileContent.image_url.url).to.equal('data:image/jpeg;base64,aGVsbG93b3JsZA==');
    });
});