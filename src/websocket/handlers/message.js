// src/websocket/handlers/message.js
import { parseMessage, formatResponse, formatError, ErrorCodes } from '../protocol.js';
import { getLogger } from '../../utils/logger.js';
import { AuthHandler } from './auth.js';
import { ChatHandler } from './chat.js';
import { AudioHandler } from './audio.js';
import { MediaHandler } from './media.js';
import { parseBinaryFrame } from '../binary-protocol.js';

const logger = getLogger();

export class MessageRouter {
  constructor(router, config, ticketRegistry) {
    this.modelRouter = router;
    this.config = config;
    this.ticketRegistry = ticketRegistry;
    this.authHandler = new AuthHandler(config);
    this.chatHandler = new ChatHandler(router, config, ticketRegistry);
    this.audioHandler = new AudioHandler(router, config, ticketRegistry);
    this.mediaHandler = new MediaHandler(router, config, ticketRegistry);
  }

  handleMessage(connection, messageBody, isBinary = false) {
    try {
      if (isBinary) {
        const parsed = parseBinaryFrame(messageBody);
        if (!parsed) return;
        
        const streamId = parsed.header.s;
        if (connection.audioStreams?.has(streamId)) {
          this.audioHandler.handleBinaryFrame(connection, messageBody);
        } else if (connection.mediaStreams?.has(streamId)) {
          this.mediaHandler.handleBinaryFrame(connection, messageBody);
        } else {
          logger.warn(`Binary frame for unknown stream ID dropped: ${streamId}`, {}, 'MessageHandler');
        }
        return;
      }

      const parsed = parseMessage(messageBody);

      if (parsed.error) {
        logger.warn('JSON-RPC parse error', { error: parsed.error, ip: connection.ip });
        connection.ws.send(JSON.stringify(parsed.error));
        return;
      }

      const { message } = parsed;
      this.routeMethod(connection, message);
    } catch (err) {
      logger.error('Error handling WebSocket message', err, null, 'MessageHandler');
      // Hard failure handling, mostly shouldn't hit due to robust transport/layer
    }
  }

  routeMethod(connection, message) {
    const { method, params, id } = message;

    logger.debug(`Received JSON-RPC method: ${method} from ${connection.id}`, {}, 'MessageHandler');

    switch (method) {
      case 'ping':
        connection.ws.send(formatResponse(id, { pong: Date.now() }));
        break;

      case 'session.initialize':
        this.authHandler.handleInitialize(connection, message);
        break;

      case 'chat.create':
        // Ensure authentication
        if (!connection.auth?.authenticated) {
          connection.ws.send(formatError(id, ErrorCodes.AUTH_REQUIRED || -32001, 'Authentication required'));
          return;
        }
        this.chatHandler.handleCreate(connection, message);
        break;

      case 'chat.cancel':
        if (!connection.auth?.authenticated) return;
        this.chatHandler.handleCancel(connection, message);
        break;

      case 'chat.append':
        if (!connection.auth?.authenticated) {
          connection.ws.send(formatError(id, ErrorCodes.AUTH_REQUIRED || -32001, 'Authentication required'));
          return;
        }
        this.chatHandler.handleAppend(connection, message);
        break;

      case 'settings.update':
        if (!connection.auth?.authenticated) return;
        this.chatHandler.handleSettingsUpdate(connection, message);
        break;

      case 'audio.start':
        if (!connection.auth?.authenticated) {
          connection.ws.send(formatError(id, ErrorCodes.AUTH_REQUIRED || -32001, 'Authentication required'));
          return;
        }
        this.audioHandler.handleStart(connection, message);
        break;

      case 'audio.stop':
        if (!connection.auth?.authenticated) return;
        this.audioHandler.handleStop(connection, message);
        break;

      case 'audio.vad':
        if (!connection.auth?.authenticated) return;
        this.audioHandler.handleVad(connection, message);
        break;

      case 'media.start':
        if (!connection.auth?.authenticated) {
          connection.ws.send(formatError(id, ErrorCodes.AUTH_REQUIRED || -32001, 'Authentication required'));
          return;
        }
        this.mediaHandler.handleStart(connection, message);
        break;

      case 'media.stop':
        if (!connection.auth?.authenticated) return;
        this.mediaHandler.handleStop(connection, message);
        break;

      default:
        logger.warn(`Unknown method: ${method}`, {}, 'MessageHandler');
        connection.ws.send(formatError(id, ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${method}`));
        break;
    }
  }
}
