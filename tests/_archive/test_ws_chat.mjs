import { WebSocket } from 'ws';

async function testWebSocket() {
  console.log("Connecting to WebSocket Real-Time...");
  const ws = new WebSocket('ws://127.0.0.1:3400/v1/realtime');

  ws.on('open', () => {
    console.log("Connected! Initializing session...");
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.initialize', params: {} }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log("Received:", msg.method || 'response', msg);
    if (msg.id === 1) {
       console.log("Initializing chat...");
       ws.send(JSON.stringify({
         jsonrpc: '2.0', id: 2, method: 'chat.create', params: {
           model: 'lmstudio-chat',
           messages: [{role: 'user', content: 'hello'}]
         }
       }));
    }
    if (msg.method === 'chat.done') {
       ws.close();
    }
  });

  ws.on('error', (err) => {
    console.error("WebSocket Error:", err);
  });
}
testWebSocket();
