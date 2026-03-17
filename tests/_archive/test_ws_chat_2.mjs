import { WebSocket } from 'ws';

async function testWebSocket() {
  const ws = new WebSocket('ws://127.0.0.1:3400/v1/realtime');

  ws.on('open', () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.initialize', params: {} }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id === 1) {
       ws.send(JSON.stringify({
         jsonrpc: '2.0', id: 2, method: 'chat.create', params: {
           model: 'lmstudio-chat',
           messages: [{role: 'user', content: 'hello'}]
         }
       }));
    }
    if (msg.method === 'chat.progress') {
       console.log('chat.progress:', JSON.stringify(msg.params));
    }
    if (msg.method === 'chat.done') {
       ws.close();
    }
  });
}
testWebSocket();
