import { expect } from 'chai';
import { AudioHandler } from '../src/websocket/handlers/audio.js';
import { createBinaryFrame } from '../src/websocket/binary-protocol.js';

describe('WebSocket Audio Handler', () => {
  let handler;
  let connectionMock;
  let sentMessages;

  beforeEach(() => {
    handler = new AudioHandler({}, {}, {});
    sentMessages = [];
    connectionMock = {
      id: 'conn-1',
      ip: '127.0.0.1',
      ws: {
        send: (msg) => sentMessages.push(typeof msg === 'string' ? JSON.parse(msg) : msg)
      }
    };
  });

  describe('audio.start', () => {
    it('should assign a stream ID and negotiate format', () => {
      const message = {
        id: 'req-1',
        method: 'audio.start',
        params: { request_id: 'req-123', direction: 'duplex' }
      };

      handler.handleStart(connectionMock, message);

      expect(sentMessages).to.have.length(1);
      const response = sentMessages[0];
      expect(response.id).to.equal('req-1');
      expect(response.result).to.have.property('stream_id');
      expect(response.result.input_format).to.equal('pcm16');
      expect(response.result.output_format).to.equal('pcm16');
      
      const streamId = response.result.stream_id;
      expect(connectionMock.audioStreams.has(streamId)).to.be.true;
      
      const stream = connectionMock.audioStreams.get(streamId);
      expect(stream.lastSequence).to.equal(-1);
    });

    it('should negotiate opus format for remote IP', () => {
      connectionMock.ip = '192.168.1.100';
      const message = {
        id: 'req-2',
        method: 'audio.start',
        params: { direction: 'duplex' }
      };

      handler.handleStart(connectionMock, message);
      
      const response = sentMessages[0];
      expect(response.result.input_format).to.equal('opus');
      expect(response.result.output_format).to.equal('opus');
    });
  });

  describe('audio.stop', () => {
    it('should stop an existing stream', () => {
      connectionMock.audioStreams = new Map();
      connectionMock.audioStreams.set('audio-1', {});

      handler.handleStop(connectionMock, {
        id: 'req-2',
        method: 'audio.stop',
        params: { stream_id: 'audio-1' }
      });

      expect(sentMessages[0].result.stopped).to.be.true;
      expect(connectionMock.audioStreams.has('audio-1')).to.be.false;
    });

    it('should return error for unknown stream', () => {
      connectionMock.audioStreams = new Map();

      handler.handleStop(connectionMock, {
        id: 'req-2',
        method: 'audio.stop',
        params: { stream_id: 'unknown-audio' }
      });

      expect(sentMessages[0].error.message).to.equal('stream_id not found');
    });
  });

  describe('Binary Frames', () => {
    let streamId;

    beforeEach(() => {
      handler.handleStart(connectionMock, { id: 'req-start', params: {} });
      streamId = sentMessages[0].result.stream_id;
      sentMessages = [];
    });

    it('should update lastSequence on successful frame', () => {
      const frame = createBinaryFrame(streamId, 0, Buffer.from('data'));
      handler.handleBinaryFrame(connectionMock, frame);

      expect(connectionMock.audioStreams.get(streamId).lastSequence).to.equal(0);
    });

    it('should detect gap when sequence skips', () => {
      handler.handleBinaryFrame(connectionMock, createBinaryFrame(streamId, 0, Buffer.from('data')));
      handler.handleBinaryFrame(connectionMock, createBinaryFrame(streamId, 2, Buffer.from('data')));

      expect(connectionMock.audioStreams.get(streamId).lastSequence).to.equal(2);
    });

    it('should drop unknown stream IDs', () => {
      const frame = createBinaryFrame('unknown-stream', 0, Buffer.from('data'));
      handler.handleBinaryFrame(connectionMock, frame);
      
      // Should not throw, should just return.
    });
  });
});
