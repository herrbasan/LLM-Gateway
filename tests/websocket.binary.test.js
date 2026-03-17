import { expect } from 'chai';
import { parseBinaryFrame, createBinaryFrame } from '../src/websocket/binary-protocol.js';

describe('WebSocket Binary Protocol', () => {
  it('should correctly encode and decode a binary frame', () => {
    const streamId = 'audio-1';
    const sequence = 42;
    const timestamp = 1705310000000;
    const payload = Buffer.from('hello world - binary payload');
    
    // Encode
    const buffer = createBinaryFrame(streamId, sequence, payload, timestamp);
    
    // Decode
    const parsed = parseBinaryFrame(buffer);
    
    expect(parsed).to.not.be.null;
    expect(parsed.header).to.deep.equal({
      s: streamId,
      t: timestamp,
      seq: sequence
    });
    expect(parsed.payload.toString('utf8')).to.equal('hello world - binary payload');
  });

  it('should return null for frame without null byte separator', () => {
    const buffer = Buffer.from('{"s":"test","seq":1}'); // no null byte
    const parsed = parseBinaryFrame(buffer);
    expect(parsed).to.be.null;
  });

  it('should return null for frame with invalid JSON header', () => {
    const buffer = Buffer.concat([
      Buffer.from('{invalid-json'),
      Buffer.from([0x00]),
      Buffer.from('payload')
    ]);
    const parsed = parseBinaryFrame(buffer);
    expect(parsed).to.be.null;
  });
});
