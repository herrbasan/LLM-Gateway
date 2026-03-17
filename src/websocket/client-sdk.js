// src/websocket/client-sdk.js
import EventEmitter from 'events';

export class ChatStream extends EventEmitter {
  constructor(client, requestId) {
    super();
    this.client = client;
    this.requestId = requestId;
  }

  cancel() {
    this.client._send('chat.cancel', { request_id: this.requestId });
  }
}

export class GatewayClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.baseUrl = options.baseUrl || 'ws://localhost:3400/v1/realtime';
    this.accessKey = options.accessKey || '';
    this.socket = null;
    this.streams = new Map();
    this.pendingRequests = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectActive = false;
  }

  connect() {
    if (this.socket) return Promise.resolve();

    return new Promise((resolve, reject) => {
      // Use global WebSocket for browser, or require('ws') for Node
      const WS = typeof window !== 'undefined' ? window.WebSocket : require('ws');
      
      const headers = this.accessKey ? { 'Authorization': `Bearer ${this.accessKey}` } : {};
      
      this.socket = new WS(this.baseUrl, { headers });

      this.socket.onopen = () => {
        this.reconnectAttempts = 0;
        this.reconnectActive = false;
        
        // Initialize session
        this._send('session.initialize', {}, 'init')
          .then((result) => resolve(result))
          .catch(reject);
      };

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this._handleMessage(data);
        } catch (e) {
          // ignore binary for this simplified SDK
        }
      };

      this.socket.onclose = (event) => {
        this.socket = null;
        this.emit('disconnected', event.code, event.reason);
        this._attemptReconnect();
      };

      this.socket.onerror = (error) => {
        if (!this.reconnectActive) {
          reject(error);
        }
      };
    });
  }

  _attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectActive = true;
    this.reconnectAttempts++;
    
    // Exponential backoff with jitter
    const delay = Math.min(30000, Math.pow(2, this.reconnectAttempts) * 1000);
    const jitter = Math.random() * 500;
    
    this.emit('reconnect', this.reconnectAttempts);
    
    setTimeout(() => {
      this.connect().catch(() => {}); // catch handled by onerror/onclose loops
    }, delay + jitter);
  }

  _handleMessage(message) {
    if (message.error && message.id && this.pendingRequests.has(message.id)) {
      this.pendingRequests.get(message.id).reject(new Error(message.error.message || 'Unknown error'));
      this.pendingRequests.delete(message.id);
      return;
    }

    if (message.result && message.id && this.pendingRequests.has(message.id)) {
      this.pendingRequests.get(message.id).resolve(message.result);
      this.pendingRequests.delete(message.id);
      return;
    }

    if (message.method) {
      const requestId = message.params?.request_id;
      const stream = this.streams.get(requestId);
      
      if (!stream) return;

      if (message.method === 'chat.progress') {
        stream.emit('progress', message.params);
      } else if (message.method === 'chat.delta') {
        stream.emit('delta', message.params);
      } else if (message.method === 'chat.done') {
        stream.emit('done', message.params);
        this.streams.delete(requestId);
      } else if (message.method === 'chat.error') {
        stream.emit('error', message.params.error);
        this.streams.delete(requestId);
      }
    }
  }

  _send(method, params = {}, explicitId = null) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1) { // 1 = OPEN
        return reject(new Error('WebSocket not connected'));
      }

      const id = explicitId || `req-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      
      this.pendingRequests.set(id, { resolve, reject });

      this.socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      }));
    });
  }

  chatStream(params) {
    const requestId = `chat-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const stream = new ChatStream(this, requestId);
    
    this.streams.set(requestId, stream);
    
    this._send('chat.create', { ...params, request_id: requestId }, requestId)
      .catch((err) => stream.emit('error', err));
      
    return stream;
  }

  async chat(params) {
    return new Promise((resolve, reject) => {
      let fullContent = '';
      const stream = this.chatStream(params);
      
      stream.on('delta', (data) => {
        if (data.choices && data.choices[0] && data.choices[0].delta.content) {
          fullContent += data.choices[0].delta.content;
        }
      });
      
      stream.on('done', () => {
        resolve({ content: fullContent });
      });
      
      stream.on('error', (err) => {
        reject(err);
      });
    });
  }

  close() {
    if (this.socket) {
      this.maxReconnectAttempts = 0; // Prevent reconnection
      this.socket.close();
    }
  }
}
