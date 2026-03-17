import { expect } from 'chai';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { setupWebSocketServer } from '../src/websocket/server.js';
import http from 'http';

describe('WebSocket v2 - Real Time Mode', () => {
    let app;
    let server;
    let config;
    let wsSystem;
    let wsUrl;
    let wsClients = [];

    before(async () => {
        config = await loadConfig();
        // Use a random port
        config.port = 0; 
        
        app = createServer(config);
        server = http.createServer(app);
        
        // Mock the router's chat completion for accurate unit testing without hitting external APIs
        const originalRouteChatCompletion = app.locals.router.routeChatCompletion.bind(app.locals.router);
        app.locals.router.routeChatCompletion = async (request) => {
            if (request.model === 'test-error-model') throw new Error('Simulated model error');
            return {
                stream: true,
                generator: (async function* () {
                    yield { choices: [{ delta: { content: 'hell' } }] };
                    await new Promise(r => setTimeout(r, 5));
                    yield { choices: [{ delta: { content: 'o' } }] };
                    await new Promise(r => setTimeout(r, 5));
                    yield { choices: [{ delta: { content: ' world' } }] };
                })()
            };
        };

        wsSystem = setupWebSocketServer(server, app, config, {
            router: app.locals.router,
            ticketRegistry: app.locals.ticketRegistry
        });

        await new Promise((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                wsUrl = `ws://127.0.0.1:${port}/v1/realtime`;
                resolve();
            });
        });
    });

    after(() => {
        for (const client of wsClients) {
            client.close();
        }
        wsSystem.shutdown();
        server.close();
    });

    function connectClient() {
        const client = new WebSocket(wsUrl);
        wsClients.push(client);
        return new Promise((resolve, reject) => {
            client.once('open', () => resolve(client));
            client.once('error', reject);
        });
    }

    function sendAndWait(client, message) {
        return new Promise((resolve) => {
            client.once('message', (data) => {
                resolve(JSON.parse(data.toString()));
            });
            client.send(JSON.stringify(message));
        });
    }

it('Local IP Auto-Authentication: allows chat.create immediately', async () => {
        const client = await connectClient();

        const response = await sendAndWait(client, {
            jsonrpc: "2.0",
            id: "test-auth",
            method: "chat.create",
            params: {
                model: "gemini-flash",
                messages: [{ role: "user", content: "hi" }]
            }
        });

        // Should not be an error because local IP auto-authenticates
        expect(response.error).to.be.undefined;
        // The first message is an acknowledgement of acceptance
        expect(response.result.accepted).to.be.true;
    });

    it('Stream Parity: successfully authenticates and streams chat completion', async () => {
        const client = await connectClient();

        // 1. Authenticate via session.initialize
        const authResponse = await sendAndWait(client, {
            jsonrpc: "2.0",
            id: "auth-1",
            method: "session.initialize",
            params: {}
        });

        expect(authResponse.result.status).to.equal('initialized');

        // 2. Chat Create
        client.send(JSON.stringify({
            jsonrpc: "2.0",
            id: "chat-1",
            method: "chat.create",
            params: {
                model: "gemini-flash",
                messages: [{ role: "user", content: "What is 2+2? Answer in one word." }]
            }
        }));

        const events = [];
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout waiting for stream')), 5000);
            
            client.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                events.push(msg);
                
                if (msg.method === 'chat.done') {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        // 3. Verify Events
        // The first message pushed to `events` without wait could be the `chat.delta` or similar.
        const deltas = events.filter(e => e.method === 'chat.delta');
        const done = events.find(e => e.method === 'chat.done');

        expect(deltas.length).to.be.greaterThan(0);
        expect(done).to.exist;
        expect(done.params.request_id).to.equal('chat-1');
        expect(done.params.cancelled).to.be.false;

        const allContent = deltas.map(d => d.params.choices[0].delta.content).join('');
        expect(allContent.length).to.be.greaterThan(0);
    });

    it('Multiplexing: handles concurrent requests correctly', async () => {
        const client = await connectClient();
        
        await sendAndWait(client, {
            jsonrpc: "2.0",
            id: "auth-multi",
            method: "session.initialize",
            params: {}
        });

        const req1 = {
            jsonrpc: "2.0",
            id: "req-1",
            method: "chat.create",
            params: { model: "gemini-flash", messages: [{ role: "user", content: "A" }] }
        };
        const req2 = {
            jsonrpc: "2.0",
            id: "req-2",
            method: "chat.create",
            params: { model: "gemini-flash", messages: [{ role: "user", content: "B" }] }
        };

        client.send(JSON.stringify(req1));
        client.send(JSON.stringify(req2));

        const stream1Deltas = [];
        const stream2Deltas = [];
        let doneCounter = 0;

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout waiting for multiplexed streams')), 5000);
            
            client.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                
                if (msg.method === 'chat.delta') {
                    if (msg.params.request_id === 'req-1') stream1Deltas.push(msg);
                    if (msg.params.request_id === 'req-2') stream2Deltas.push(msg);
                } else if (msg.method === 'chat.done') {
                    doneCounter++;
                    if (doneCounter === 2) {
                        clearTimeout(timeout);
                        resolve();
                    }
                }
            });
        });

        expect(stream1Deltas.length).to.be.greaterThan(0);
        expect(stream2Deltas.length).to.be.greaterThan(0);
        
        // Ensure no cross-contamination of Request IDs
        stream1Deltas.forEach(d => expect(d.params.request_id).to.equal('req-1'));
        stream2Deltas.forEach(d => expect(d.params.request_id).to.equal('req-2'));
    });

    it('Cancellation: propagates client cancellation correctly', async () => {
        const client = await connectClient();
        
        await sendAndWait(client, {
            jsonrpc: "2.0",
            id: "auth-cancel",
            method: "session.initialize",
            params: {}
        });

        // Add a long-running response block
        app.locals.router.routeChatCompletion = async (request) => {
            return {
                stream: true,
                generator: (async function* () {
                    for (let i = 0; i < 20; i++) {
                        yield { choices: [{ delta: { content: 'ping' } }] };
                        await new Promise(r => setTimeout(r, 10)); // slow it down
                    }
                })()
            };
        };

        client.send(JSON.stringify({
            jsonrpc: "2.0",
            id: "req-cancel",
            method: "chat.create",
            params: { model: "gemini-flash", messages: [{ role: "user", content: "Tell me a story." }] }
        }));

        const events = [];
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout waiting for cancel')), 5000);
            
            client.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                events.push(msg);

                const deltaCount = events.filter(e => e.method === 'chat.delta').length;

                if (msg.method === 'chat.delta' && deltaCount === 1) {
                    client.send(JSON.stringify({
                        jsonrpc: "2.0",
                        method: "chat.cancel",
                        params: { request_id: "req-cancel" }
                    }));
                }
                
                if (msg.method === 'chat.done') {
                    console.log("CANCELLATION DONE EVENT:", JSON.stringify(msg));
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        const done = events.find(e => e.method === 'chat.done');
        expect(done).to.exist;
        expect(done.params.cancelled).to.be.true;
    });

    it('Incremental updates: handles chat.append and maintains buffer', async () => {
        const client = await connectClient();
        
        await sendAndWait(client, {
            jsonrpc: "2.0",
            id: "auth-append",
            method: "session.initialize",
            params: {}
        });

        let routerLogs = [];
        app.locals.router.routeChatCompletion = async (request) => {
            routerLogs.push([...request.messages]); // collect what the router sees as snapshot
            return {
                stream: true,
                generator: (async function* () {
                    yield { choices: [{ delta: { content: 'Hi there' } }] };
                })()
            };
        };

        // First message via chat.create to init buffer
        client.send(JSON.stringify({
            jsonrpc: "2.0",
            id: "req-app-1",
            method: "chat.create",
            params: { model: "gemini-flash", messages: [{ role: "user", content: "First." }] }
        }));

        // Drain the stream until chat.done
        await new Promise((resolve, reject) => {
             const t = setTimeout(() => reject(new Error('timeout 1')), 2000);
             client.on('message', function handler(data) {
                const msg = JSON.parse(data.toString());
                if (msg.method === 'chat.done' && msg.params.request_id === 'req-app-1') {
                    client.off('message', handler);
                    clearTimeout(t);
                    resolve();
                }
            });
        });

        expect(routerLogs.length).to.equal(1);
        expect(routerLogs[0].length).to.equal(1);
        expect(routerLogs[0][0].content).to.equal("First.");

        // Append second message
         client.send(JSON.stringify({
            jsonrpc: "2.0",
            id: "req-app-2",
            method: "chat.append",
            params: { message: { role: "user", content: "Second." } }
        }));

        await new Promise((resolve, reject) => {
             const t = setTimeout(() => reject(new Error('timeout 2')), 2000);
             client.on('message', function handler(data) {
                const msg = JSON.parse(data.toString());
                if (msg.method === 'chat.done' && msg.params.request_id === 'req-app-2') {
                    client.off('message', handler);
                    clearTimeout(t);
                    resolve();
                }
            });
        });

        // The router should have seen 3 messages initially, but because we just passed reference to connection.conversationBuffer
        // and after it finishes it appends a 4th assistant message, receivedMessages length might be 4 if we look at it afterwards.
        // Let's capture a snapshot of what router originally got.
        expect(routerLogs.length).to.equal(2);
        expect(routerLogs[1].length).to.equal(3);
        expect(routerLogs[1][2].content).to.equal("Second.");
        expect(routerLogs[1][1].role).to.equal("assistant");
    });
});
