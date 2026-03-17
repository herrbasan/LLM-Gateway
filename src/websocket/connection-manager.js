// src/websocket/connection-manager.js
import { getLogger } from '../utils/logger.js';
import { wsMetrics } from './metrics.js';

const logger = getLogger();

export class ConnectionManager {
  constructor(options = {}) {
    this.connections = new Map();
    this.maxConnections = options.maxConnections || 100;
  }

  addConnection(ws, req) {
    if (this.connections.size >= this.maxConnections) {
      logger.warn('WebSocket maximum connections reached. Rejecting connection.');
      wsMetrics.increment('ws_connections_rejected');
      ws.close(1013, 'Try Again Later'); // 1013 = Try Again Later
      return null;
    }

    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Wrap ws.send to track backpressure
    const originalSend = ws.send.bind(ws);
    const highWaterMark = 1024 * 64; // 64KB
    
    ws.send = (data, options, cb) => {
      if (ws.bufferedAmount > highWaterMark) {
        wsMetrics.increment('ws_backpressure_events_total');
      }
      originalSend(data, options, cb);
    };

    // Store connection context
    const connection = {
      id: connectionId,
      ws,
      ip: req.socket.remoteAddress,
      connectedAt: Date.now(),
      lastActive: Date.now(),
      isAlive: true,
      auth: {
        authenticated: false,
        type: null
      },
      bufferTokens: 0,
      conversationBuffer: [],
      activeRequests: new Map()
    };

    this.connections.set(connectionId, connection);
    wsMetrics.increment('ws_connections_total');
    wsMetrics.set('ws_connections_active', this.connections.size);
    // Handle ping/pong for keep-alive
    ws.on('pong', () => {
      if (this.connections.has(connectionId)) {
        this.connections.get(connectionId).isAlive = true;
      }
    });

    // Cleanup on close
    ws.on('close', () => {
      this.removeConnection(connectionId);
    });

    return connection;
  }

  getConnection(id) {
    return this.connections.get(id);
  }

  removeConnection(id) {
    const connection = this.connections.get(id);
    if (!connection) return;

    // Cleanup resources
    logger.info(`WebSocket connection closed: ${id}`, { duration: Date.now() - connection.connectedAt });
    this.connections.delete(id);
    wsMetrics.set('ws_connections_active', this.connections.size);
  }

  // Ping all connections to check if they are alive
  pingConnections() {
    for (const [id, connection] of this.connections.entries()) {
      if (!connection.isAlive) {
        logger.debug(`WebSocket connection timeout: ${id}`);
        connection.ws.terminate();
        this.removeConnection(id);
        continue;
      }
      
      connection.isAlive = false; // Mark false, wait for pong
      try {
        connection.ws.ping();
      } catch (err) {
        logger.warn(`Failed to ping WebSocket connection: ${id}`);
        this.removeConnection(id);
      }
    }
  }

  closeAll() {
    for (const [id, connection] of this.connections.entries()) {
      // Cancel active requests
      if (connection.activeRequests) {
        for (const [reqId, req] of connection.activeRequests.entries()) {
          try {
            req.cancel();
          } catch (e) {}
        }
      }
      connection.ws.close(1001, 'Server going away');
    }
    this.connections.clear();
    wsMetrics.set('ws_connections_active', 0);
  }
}
