// src/websocket/server.js
import { WebSocketServer } from 'ws';
import { ConnectionManager } from './connection-manager.js';
import { MessageRouter } from './handlers/message.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export function setupWebSocketServer(server, app, config, dependencies) {
  const wss = new WebSocketServer({ 
    noServer: true,
    clientTracking: false // Managed by ConnectionManager
  });

  const connectionManager = new ConnectionManager({
    maxConnections: config.ws?.maxConnections || 100
  });

  const messageRouter = new MessageRouter(
    dependencies.router,
    config,
    dependencies.ticketRegistry
  );

  server.on('upgrade', (request, socket, head) => {
    // Only upgrade matching path
    if (request.url !== '/v1/realtime') {
      socket.destroy();
      return;
    }

    // IP Validation - Local Only for Phase 1
    const isLocalOnly = typeof config.ws?.localOnly === 'boolean' ? config.ws.localOnly : true;
    const clientIp = request.socket.remoteAddress;

    // Provide wildcard checking for allowed IPs
    const checkIpTrusted = (ip) => {
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
      
      const whitelist = config.ws?.whitelistIps;
      if (Array.isArray(whitelist)) {
        return whitelist.some(pattern => {
          if (pattern === ip) return true;
          if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1);
            return ip.startsWith(prefix);
          }
          return false;
        });
      }
      return false;
    };

    const isTrustedIp = checkIpTrusted(clientIp);

    if (isLocalOnly && !isTrustedIp) {
      logger.warn(`WebSocket upgrade rejected (not a trusted IP): ${clientIp}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    let preAuthenticated = false;

    // Auto-authenticate trusted ip addresses (localhost or whitelisted)
    if (isTrustedIp) {
      preAuthenticated = true;
    } else {
      // Remote IP, check 'Authorization' header for access key
      const authHeader = request.headers['authorization'];
      const expectedKey = config.ws?.accessKey || process.env.GATEWAY_ACCESS_KEY;
      
      if (authHeader) {
        const accessKey = authHeader.replace('Bearer ', '');
        if (expectedKey && accessKey === expectedKey) {
            preAuthenticated = true;
        } else {
            logger.warn(`WebSocket upgrade rejected (invalid access key via header): ${clientIp}`);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
      }
      // If no header is provided here, upgrade succeeds but they MUST authenticate via session.initialize
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws._preAuthenticated = preAuthenticated;
      ws._isLocalIp = isTrustedIp;
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    const connection = connectionManager.addConnection(ws, request);

    if (!connection) return; // connection object setup failed, e.g. quota limit reached

    if (!connection.auth) connection.auth = {};
    if (ws._preAuthenticated) {
      connection.auth.authenticated = true;
    }

    ws.on('message', (message, isBinary) => {
      // Pass the raw Buffer/String message body to the handler
      messageRouter.handleMessage(connection, message, isBinary);
    });

    ws.on('error', (error) => {
      logger.error(`WebSocket connection error: ${connection.id}`, error);
    });
  });

  // Keep-Alive Ping Interval
  const pingInterval = setInterval(() => {
    connectionManager.pingConnections();
  }, 30000); // 30 seconds

  // Close interval on shutdown
  wss.on('close', () => clearInterval(pingInterval));

  logger.info('WebSocket Real-Time server initialized on /v1/realtime');

  return {
    wss,
    connectionManager,
    shutdown: () => {
      clearInterval(pingInterval);
      connectionManager.closeAll();
      wss.close();
    }
  };
}
