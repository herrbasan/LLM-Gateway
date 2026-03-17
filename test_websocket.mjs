import { WebSocket } from 'ws';

async function testWebSocket() {
  console.log("Connecting to WebSocket Real-Time...");
  const ws = new WebSocket('ws://127.0.0.1:3400/v1/realtime');

  ws.on('open', () => {
    console.log("Connected! Sending ping...");
    const pingMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping'
    };
    ws.send(JSON.stringify(pingMessage));
  });

  ws.on('message', (data) => {
    console.log("Received a message:");
    console.dir(JSON.parse(data.toString()), { depth: null });
    ws.close();
  });

  ws.on('error', (err) => {
    console.error("WebSocket Error:", err);
  });
}

testWebSocket();
