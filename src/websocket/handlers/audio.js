// src/websocket/handlers/audio.js
import { formatResponse, formatError, ErrorCodes } from '../protocol.js';
import { getLogger } from '../../utils/logger.js';
import { parseBinaryFrame } from '../binary-protocol.js';

const logger = getLogger();

export class AudioHandler {
  constructor(router, config, ticketRegistry) {
    this.router = router;
    this.config = config;
    this.ticketRegistry = ticketRegistry;
  }

  handleStart(connection, message) {
    const { params, id } = message;
    const requestId = params?.request_id || `req-${Date.now()}`;
    const direction = params?.direction || 'duplex';

    const streamId = `s-${connection.id}-${Date.now()}`;

    // Negotiate format
    const isLocalIp = connection.ip === '127.0.0.1' || connection.ip === '::1' || connection.ip === '::ffff:127.0.0.1';
    
    const format = {
      stream_id: streamId,
      input_format: isLocalIp ? 'pcm16' : 'opus',
      output_format: isLocalIp ? 'pcm16' : 'opus',
      sample_rate: 24000,
      channels: 1,
      frame_duration_ms: 20
    };

    if (!connection.audioStreams) {
      connection.audioStreams = new Map();
    }

    connection.audioStreams.set(streamId, {
      id: streamId,
      format,
      direction,
      startedAt: Date.now(),
      lastSequence: -1
    });

    logger.debug(`Audio stream started: ${streamId}`);
    connection.ws.send(formatResponse(id, format));
  }

  handleStop(connection, message) {
    const { params, id } = message;
    const streamId = params?.stream_id;

    if (!streamId) {
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, 'stream_id is required'));
      return;
    }

    if (!connection.audioStreams?.has(streamId)) {
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, 'stream_id not found'));
      return;
    }

    connection.audioStreams.delete(streamId);
    logger.debug(`Audio stream stopped: ${streamId}`);
    connection.ws.send(formatResponse(id, { stopped: true }));
  }

  handleVad(connection, message) {
    const { params, id } = message;
    const streamId = params?.stream_id;
    const event = params?.event;

    if (!streamId) {
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, 'stream_id is required'));
      return;
    }

    if (!connection.audioStreams?.has(streamId)) {
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, 'stream_id not found'));
      return;
    }

    logger.debug(`VAD event for ${streamId}: ${event}`);
    
    // In a real implementation this might trigger generation or interrupt streaming
    if (id) {
        connection.ws.send(formatResponse(id, { accepted: true }));
    }
  }

  handleBinaryFrame(connection, frame) {
    const parsed = parseBinaryFrame(frame);
    if (!parsed) return;
    
    const { header, payload } = parsed;
    const { s: streamId, seq, t } = header;

    if (!connection.audioStreams?.has(streamId)) {
      logger.warn(`Binary frame for unknown stream ID dropped: ${streamId}`);
      return;
    }

    const stream = connection.audioStreams.get(streamId);
    
    // Gap detection
    if (seq !== stream.lastSequence + 1 && stream.lastSequence !== -1) {
      logger.warn(`Binary frame gap detected for ${streamId}: expected ${stream.lastSequence + 1}, got ${seq}`);
    }
    
    stream.lastSequence = seq;

    logger.debug(`Received binary frame for ${streamId}, seq: ${seq}, bytes: ${payload.length}`);
    
    // In a real implementation this would route the audio data to the backend or model
  }
}