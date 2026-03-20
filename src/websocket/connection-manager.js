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
      userAgent: req.headers['user-agent'] || null,
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
    logger.info(`WebSocket connection opened: ${connectionId}`, {
      ip: connection.ip,
      userAgent: connection.userAgent,
      activeConnections: this.connections.size
    });
    wsMetrics.increment('ws_connections_total');
    wsMetrics.set('ws_connections_active', this.connections.size);
    // Handle ping/pong for keep-alive
    ws.on('pong', () => {
      if (this.connections.has(connectionId)) {
        const activeConnection = this.connections.get(connectionId);
        activeConnection.isAlive = true;
        activeConnection.lastActive = Date.now();
        logger.debug(`WebSocket pong received: ${connectionId}`, {
          activeRequests: activeConnection.activeRequests.size,
          bufferedAmount: activeConnection.ws.bufferedAmount || 0
        });
      }
    });

    ws.on('error', (error) => {
      logger.warn(`WebSocket connection error: ${connectionId}`, {
        error: error.message,
        activeRequests: connection.activeRequests.size,
        bufferedAmount: connection.ws.bufferedAmount || 0
      });
    });

    // Cleanup on close
    ws.on('close', (code, reasonBuffer) => {
      const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : (reasonBuffer || '');
      logger.info(`WebSocket close event: ${connectionId}`, {
        code,
        reason,
        activeRequests: connection.activeRequests.size,
        bufferedAmount: connection.ws.bufferedAmount || 0,
        readyState: describeReadyState(connection.ws.readyState)
      });
      this.removeConnection(connectionId, { code, reason });
    });

    return connection;
  }

  getConnection(id) {
    return this.connections.get(id);
  }

  removeConnection(id, closeInfo = null) {
    const connection = this.connections.get(id);
    if (!connection) return;

    // Cancel active requests to prevent zombie downstream processing
    if (connection.activeRequests) {
      for (const [reqId, req] of connection.activeRequests.entries()) {
        try {
          if (typeof req.cancel === 'function') {
            logger.info(`Cancelling active request on connection close: ${id}`, {
              requestId: reqId,
              requestState: req.state,
              closeInfo
            });
            req.cancel();
          }
        } catch (e) {
          logger.warn(`Failed to cancel request ${reqId} on connection close`, { error: e.message });
        }
      }
    }

    // Cleanup lingering media/audio tracking timers or maps
    if (connection.mediaStreams) {
      for (const stream of connection.mediaStreams.values()) {
        if (stream.timeout) clearTimeout(stream.timeout);
      }
      connection.mediaStreams.clear();
    }

    if (connection.audioStreams) {
      connection.audioStreams.clear();
    }

    // Cleanup resources
    logger.info(`WebSocket connection closed: ${id}`, {
      duration: Date.now() - connection.connectedAt,
      closeInfo,
      activeRequests: connection.activeRequests.size,
      bufferedAmount: connection.ws.bufferedAmount || 0,
      readyState: describeReadyState(connection.ws.readyState)
    });
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
        logger.debug(`Sending WebSocket ping: ${id}`, {
          activeRequests: connection.activeRequests.size,
          bufferedAmount: connection.ws.bufferedAmount || 0
        });
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

function describeReadyState(readyState) {
  switch (readyState) {
    case 0:
      return 'CONNECTING';
    case 1:
      return 'OPEN';
    case 2:
      return 'CLOSING';
    case 3:
      return 'CLOSED';
    default:
      return `UNKNOWN(${readyState})`;
  }
}
