// src/websocket/binary-protocol.js
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export function parseBinaryFrame(buffer) {
  // Find the null byte separator
  const separatorIndex = buffer.indexOf(0x00);
  
  if (separatorIndex === -1) {
    logger.warn('Malformed binary frame: no null byte separator');
    return null;
  }
  
  try {
    const headerBuffer = buffer.subarray(0, separatorIndex);
    const headerString = headerBuffer.toString('utf-8');
    const header = JSON.parse(headerString);
    
    const payload = buffer.subarray(separatorIndex + 1);
    
    return {
      header,
      payload
    };
  } catch (error) {
    logger.warn('Malformed binary frame: invalid JSON header', { error: error.message });
    return null;
  }
}

export function createBinaryFrame(streamId, sequence, payload, timestamp = Date.now()) {
  const header = {
    s: streamId,
    t: timestamp,
    seq: sequence
  };
  
  const headerString = JSON.stringify(header);
  const headerBuffer = Buffer.from(headerString, 'utf-8');
  const separatorBuffer = Buffer.from([0x00]);
  
  return Buffer.concat([headerBuffer, separatorBuffer, payload]);
}
