// src/websocket/handlers/media.js
import { formatResponse, formatError, formatNotification, ErrorCodes } from '../protocol.js';
import { getLogger } from '../../utils/logger.js';
import { parseBinaryFrame } from '../binary-protocol.js';

const logger = getLogger();

export class MediaHandler {
  constructor(router, config, ticketRegistry) {
    this.router = router;
    this.config = config;
    this.ticketRegistry = ticketRegistry;
    this.maxMediaStreamsPerConnection = this.config?.maxMediaStreamsPerConnection || 10;
    this.maxMediaBytes = this.config?.maxMediaBytes || 50 * 1024 * 1024; // 50MB default
    this.mediaStreamTimeoutMs = this.config?.mediaStreamTimeoutMs || 5 * 60 * 1000; // 5 mins default
  }

  handleStart(connection, message) {
    const { params, id } = message;
    const mimeType = params?.mime_type || 'application/octet-stream';
    const streamId = params?.stream_id || `m-${connection.id}-${Date.now()}`;

    if (!connection.mediaStreams) {
      connection.mediaStreams = new Map();
    }

    if (connection.mediaStreams.has(streamId)) {
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, 'stream_id already exists'));
      return;
    }

    // Protection 2: Max streams per connection
    if (connection.mediaStreams.size >= this.maxMediaStreamsPerConnection) {
      connection.ws.send(formatError(id, ErrorCodes.RATE_LIMIT_EXCEEDED || -32000, 'Too many concurrent media streams'));
      return;
    }

    // Protection 3: Stale stream cleanup (TTL)
    const cleanupTimeout = setTimeout(() => {
      if (connection.mediaStreams && connection.mediaStreams.has(streamId)) {
        logger.warn(`Media stream ${streamId} timed out and was cleaned up`, {}, 'MediaHandler');
        connection.mediaStreams.delete(streamId);
      }
    }, this.mediaStreamTimeoutMs);

    connection.mediaStreams.set(streamId, {
      id: streamId,
      mimeType,
      chunks: [],
      totalSize: 0,
      startedAt: Date.now(),
      lastSequence: -1,
      completed: false,
      timeout: cleanupTimeout
    });

    logger.debug(`Media stream started: ${streamId} (${mimeType})`, {}, 'MediaHandler');
    
    connection.ws.send(formatResponse(id, {
      stream_id: streamId,
      mime_type: mimeType,
      url: `gateway-media://${streamId}`
    }));
  }

  handleStop(connection, message) {
    const { params, id } = message;
    const streamId = params?.stream_id;

    if (!streamId) {
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, 'stream_id is required'));
      return;
    }

    if (!connection.mediaStreams?.has(streamId)) {
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, 'stream_id not found'));
      return;
    }

    const stream = connection.mediaStreams.get(streamId);
    
    // Clear cleanup timeout since stream is purposefully stopped
    if (stream.timeout) {
      clearTimeout(stream.timeout);
      stream.timeout = null;
    }

    stream.completed = true;

    logger.debug(`Media stream stopped: ${streamId}, total size: ${stream.totalSize} bytes`, {}, 'MediaHandler');
    
    connection.ws.send(formatResponse(id, { 
      stopped: true,
      stream_id: streamId,
      total_size: stream.totalSize,
      url: `gateway-media://${streamId}`
    }));
  }

  handleBinaryFrame(connection, frame) {
    const parsed = parseBinaryFrame(frame);
    if (!parsed) return;
    
    const { header, payload } = parsed;
    const { s: streamId, seq } = header;

    if (!connection.mediaStreams?.has(streamId)) {
      logger.warn(`Binary frame for unknown media stream dropped: ${streamId}`, {}, 'MediaHandler');
      return;
    }

    const stream = connection.mediaStreams.get(streamId);
    
    if (stream.completed) {
      logger.warn(`Binary frame for completed media stream dropped: ${streamId}`, {}, 'MediaHandler');
      return;
    }

    // Protection 1: Max stream size limits
    if (stream.totalSize + payload.length > this.maxMediaBytes) {
      logger.error(`Media stream ${streamId} exceeded max size of ${this.maxMediaBytes} bytes. Dropping stream.`, null, null, 'MediaHandler');
      
      // Clear timeout and remove from maps
      if (stream.timeout) clearTimeout(stream.timeout);
      connection.mediaStreams.delete(streamId);
      
      // Try to notify the client async using standard json-rpc error event pattern
      try {
        connection.ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'error',
          params: {
            code: ErrorCodes.INTERNAL_ERROR || -32603,
            message: `Media stream exceeded max size limit of ${this.maxMediaBytes} bytes`,
            data: { stream_id: streamId }
          }
        }));
      } catch (e) {
        // Ignore send errors if connection is closed
      }
      return;
    }

    // Gap detection
    if (seq !== stream.lastSequence + 1 && stream.lastSequence !== -1) {
      logger.warn(`Binary frame gap detected for media ${streamId}: expected ${stream.lastSequence + 1}, got ${seq}`, {}, 'MediaHandler');
    }
    
    stream.lastSequence = seq;
    stream.chunks.push(payload);
    stream.totalSize += payload.length;

    // Send a progress notification every ~1MB
    const MB = 1024 * 1024;
    const previousMegabytes = Math.floor((stream.totalSize - payload.length) / MB);
    const currentMegabytes = Math.floor(stream.totalSize / MB);
    
    if (currentMegabytes > previousMegabytes) {
      try {
        connection.ws.send(formatNotification('media.progress', {
          stream_id: streamId,
          bytes_received: stream.totalSize,
          megabytes_received: currentMegabytes
        }));
      } catch (e) {
        // ignore
      }
    }

    logger.debug(`Received binary frame for media ${streamId}, seq: ${seq}, bytes: ${payload.length}`, {}, 'MediaHandler');
  }
}
