# WebSocket Real-Time Mode: Development Plan

> **Status**: Near Completion  
> **Target**: v2.1 release  
> **Approach**: Phased implementation with incremental delivery

---

## Overview

This document defines the phased implementation approach for the WebSocket Real-Time Mode feature. Each phase builds upon the previous, delivering incremental value while maintaining system stability.

**Reference Document**: [WebSocket Real-Time Mode Design Proposal](./websocket_realtime_mode.md)

---

## Phase 1: Foundation [COMPLETED]

**Goal**: Establish core WebSocket infrastructure with basic connectivity

**Duration**: 1-2 weeks  
**Priority**: P0 (blocking all subsequent phases)

### Deliverables

| Component | Reference | Description |
|-----------|-----------|-------------|
| `websocket/server.js` | [Section 6.2](./websocket_realtime_mode.md#62-integration-with-express-server) | WebSocket server setup, HTTP upgrade handling |
| `websocket/connection-manager.js` | [Section 6.3](./websocket_realtime_mode.md#63-connection-manager) | Connection lifecycle, IP validation (local-only) |
| `websocket/protocol.js` | [Section 4.2](./websocket_realtime_mode.md#42-message-framing-json-rpc-20) | JSON-RPC 2.0 encoding/decoding |
| `websocket/handlers/message.js` (stub) | [Section 6.5](./websocket_realtime_mode.md#65-message-handler-with-resource-guards) | Message routing framework |

### Scope

**In**:
- Local-only IP validation ([Section 3](./websocket_realtime_mode.md#3-security-model-local-only-websocket-access))
- Native WebSocket ping/pong ([Section 4.6](./websocket_realtime_mode.md#46-heartbeat-native-websocket-pingpong))
- Basic JSON-RPC request/response handling
- Connection limits (global + per-client)
- Configuration loading (`WS_ENABLED`, `WS_LOCAL_ONLY`)

**Out**:
- Authentication (Phase 2)
- Business logic handlers (Phase 2)
- Binary frames (Phase 4)
- Metrics (Phase 5)

### Success Criteria

```bash
# Test: WebSocket connection established
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  http://localhost:3400/v1/realtime

# Expected: HTTP/1.1 101 Switching Protocols
```

### Verification & Testing Strategy

*See [Test Strategy: Connection & Security](./websocket_test_strategy.md#1-connection--security-testing-phase-1--2) and [Test Strategy: Protocol & State Machine](./websocket_test_strategy.md#2-protocol--state-machine-testing-phase-1--3) for full methodology.*

- [x] **IP Validation**: Connection from localhost succeeds, external IP rejected (1008)
- [x] **Connection Limits**: Limits enforced, ping/pong keeps connection alive
- [x] **JSON-RPC Validation**: Fuzz testing validates missing fields/malformed JSON
- [x] Graceful disconnect handling

---

## Phase 2: Chat over WebSocket [COMPLETED]

**Goal**: Achieve feature parity with HTTP `/v1/chat/completions`

**Duration**: 2-3 weeks  
**Priority**: P0 (core feature)  
**Depends On**: Phase 1

### Deliverables

| Component | Reference | Description |
|-----------|-----------|-------------|
| `websocket/handlers/auth.js` | [Section 4.4](./websocket_realtime_mode.md#44-authentication) | `session.initialize`, upgrade-header auth |
| `websocket/handlers/chat.js` | [Section 6.5](./websocket_realtime_mode.md#65-message-handler-with-resource-guards) | `chat.create`, streaming via `chat.delta` |
| `websocket/request-state.js` | [Section 6.4](./websocket_realtime_mode.md#64-request-state-machine) | Request lifecycle tracking |

### Scope

**In**:
- Authentication via HTTP upgrade header ([Section 4.4](./websocket_realtime_mode.md#44-authentication))
- `chat.create` with full context ([Section 4.8](./websocket_realtime_mode.md#48-message-types))
- Streaming responses (`chat.delta` notifications) ([Section 4.10](./websocket_realtime_mode.md#410-streaming-protocol-json-rpc-compliance))
- Request ID correlation for multiplexing
- Basic error handling

**Out**:
- `chat.append` (Phase 3)
- Cancellation (Phase 3)
- Progress notifications (Phase 3)
- Connection buffer (Phase 3)

### API Coverage

```javascript
// Must support:
session.initialize → session.initialized
chat.create → chat.delta (stream) → chat.done

// Not yet:
chat.append
chat.cancel
chat.progress
settings.update
```

### Success Criteria

```javascript
// Client can complete a full chat session
const ws = new WebSocket('ws://localhost:3400/v1/realtime');

// 1. Authenticate
// 2. Send chat.create
// 3. Receive streaming chat.delta notifications
// 4. Receive chat.done
// 5. Result matches HTTP API output
```

### Verification & Testing Strategy

*See [Test Strategy: Business Logic & Streaming](./websocket_test_strategy.md#3-business-logic--streaming-phase-2--3) and [Test Strategy: Protocol & Multiplexing](./websocket_test_strategy.md#2-protocol--state-machine-testing-phase-1--3) for full methodology.*

- [x] **Stream Parity**: HTTP SSE output perfectly matches streaming `chat.delta` notifications
- [x] **Authentication**: Valid session/upgrade-headers accepted, invalid cleanly rejected
- [x] **Multiplexing**: E2E test shows simultaneous `chat.create` requests correlate accurately via Request IDs
- [x] JSON-RPC request/response round-trip < 10ms
- [x] HTTP API unchanged (regression test)

---

## Phase 3: Advanced Features [COMPLETED]

**Goal**: Add interactivity features (cancellation, incremental updates, progress)

**Duration**: 2 weeks  
**Priority**: P1 (enhances UX significantly)  
**Depends On**: Phase 2

### Deliverables

| Component | Reference | Description |
|-----------|-----------|-------------|
| `chat.cancel` handler | [Section 6.5](./websocket_realtime_mode.md#65-message-handler-with-resource-guards) | Request cancellation with AbortSignal |
| `chat.append` handler | [Section 4.5](./websocket_realtime_mode.md#45-performance-optimization-connection-scoped-context-buffer) | Incremental context updates |
| Connection buffer | [Section 4.5](./websocket_realtime_mode.md#45-performance-optimization-connection-scoped-context-buffer) | Buffer size enforcement, compaction triggers |
| `chat.progress` | [Section 6.5](./websocket_realtime_mode.md#65-message-handler-with-resource-guards) | Routing/context/compaction progress |

### Scope

**In**:
- Request state machine (PENDING → PROCESSING → COMPLETED/CANCELLED/FAILED) ([Section 6.4](./websocket_realtime_mode.md#64-request-state-machine))
- `chat.cancel` with upstream cancellation (if adapters support AbortSignal) ([Section 6.5](./websocket_realtime_mode.md#65-message-handler-with-resource-guards))
- `chat.append` for efficient incremental updates ([Section 4.5](./websocket_realtime_mode.md#45-performance-optimization-connection-scoped-context-buffer))
- Connection-scoped context buffer with `maxBufferTokens` limit
- `chat.progress` notifications (routing, context phases)
- `settings.update` handler

**Out**:
- Binary frames (Phase 4)
- Audio streams (Phase 4)
- Metrics collection (Phase 5)

### Prerequisites for Cancellation

Per [Section 12](./websocket_realtime_mode.md#12-prerequisites--migration-notes):
- `ModelRouter.routeChatCompletion()` must accept `AbortSignal`
- Adapters must forward signal to `fetch()` calls
- If not ready, cancellation stops at gateway (documented limitation)

### Success Criteria

```javascript
// Cancellation
const stream = client.chatStream({...});
setTimeout(() => stream.cancel(), 500);  // Cancel after 500ms
// → chat.done with cancelled: true

// Append (efficient)
await client.chatAppend({ message: "new msg" });
// → Only new message sent over wire
```

### Verification & Testing Strategy

*See [Test Strategy: Business Logic & Streaming](./websocket_test_strategy.md#3-business-logic--streaming-phase-2--3) and [State Machine Transitions](./websocket_test_strategy.md#2-protocol--state-machine-testing-phase-1--3) for full methodology.*

- [x] **State Machine Validation**: Unit tests prevent invalid state transitions
- [x] **Cancellation Propagation**: `client.cancel` emits `chat.done (cancelled: true)` and aborts adapter `fetch`
- [x] **Context Buffering**: `chat.append` accurately builds prompt up to `maxBufferTokens`
- [x] Buffer limit enforced, triggers compaction event
- [x] Progress notifications received for slow operations

---

## Phase 4: Binary Protocol & Audio [COMPLETED]

**Goal**: Support efficient binary transmission for audio/video use cases

**Duration**: 2-3 weeks  
**Priority**: P2 (needed for voice agents)  
**Depends On**: Phase 3

### Deliverables

| Component | Reference | Description |
|-----------|-----------|-------------|
| Binary frame decoder | [Section 4.7](./websocket_realtime_mode.md#47-binary-protocol--audio-streams) | Header-prefixed binary frame parsing |
| `audio.start/stop` | [Section 4.7](./websocket_realtime_mode.md#47-binary-protocol--audio-streams) | Audio stream lifecycle |
| `audio.vad` | [Section 4.7](./websocket_realtime_mode.md#47-binary-protocol--audio-streams) | Voice activity detection events |
| Format negotiation | [Section 4.7](./websocket_realtime_mode.md#47-binary-protocol--audio-streams) | PCM16, Opus support |

### Scope

**In**:
- Binary WebSocket frame handling (`isBinary` flag)
- Header format: `{"s": stream_id, "t": timestamp, "seq": n}` + null byte + payload ([Section 4.7](./websocket_realtime_mode.md#47-binary-protocol--audio-streams))
- Stream lifecycle: `audio.start` → binary frames → `audio.stop`
- Gap detection via sequence numbers
- Format negotiation: PCM16 (local) vs Opus (networked)
- Unknown stream ID handling (drop, don't crash)

**Out**:
- Video streaming (future)
- Real-time transcription (future)
- Audio mixing/routing (future)

### Success Criteria

```javascript
// Binary audio streaming
const result = await client.audioStart({ direction: 'duplex' });
const streamId = result.stream_id;

// Send binary frames
// Header: { s: streamId, t: Date.now(), seq: 0 }
// Payload: <960 bytes PCM16>

// Receive binary frames from server
```

### Verification & Testing Strategy

*See [Test Strategy: Binary Protocol Testing](./websocket_test_strategy.md#4-binary-protocol-testing-phase-4) for full methodology.*

- [x] **Frame Decoding**: Unit tests confirm sequence, timestamp, payload parsing
- [x] **Gap Detection**: Logs correctly capture skipped binary frames
- [x] **Format Negotiation**: PCM16 negotiates locally, Opus remotely
- [x] Unknown stream IDs dropped gracefully
- [x] Bandwidth usage < 50 KB/s for 24kHz mono

---

## Phase 5: Production Readiness [PENDING]

**Goal**: Metrics, monitoring, graceful degradation, testing

**Duration**: 2 weeks  
**Priority**: P1 (required for production)  
**Depends On**: Phases 1-4

### Deliverables

| Component | Reference | Description |
|-----------|-----------|-------------|
| Metrics collection | [Section 11](./websocket_realtime_mode.md#11-metrics) | All documented metrics implemented |
| Graceful shutdown | [Section 7](./websocket_realtime_mode.md#7-graceful-shutdown) | Drain active requests, notify clients |
| `ws` library integration | [Section 6.2](./websocket_realtime_mode.md#62-integration-with-express-server) | Production-grade WebSocket server |
| Client SDK | [Section 9](./websocket_realtime_mode.md#9-client-sdk-design) | JavaScript/TypeScript reference implementation |

### Metrics to Implement

| Metric | Type | Implementation |
|--------|------|----------------|
| `ws_connections_active` | Gauge | ConnectionManager.size |
| `ws_connections_total` | Counter | On successful connection |
| `ws_first_token_latency_seconds` | Histogram | RequestContext.firstTokenLatencyMs |
| `ws_request_duration_seconds` | Histogram | RequestContext.totalLatencyMs |
| `ws_errors_total` | Counter | By error code |
| `ws_backpressure_events_total` | Counter | When bufferedAmount > highWaterMark |
| `ws_request_cancelled_total` | Counter | On successful cancellation |

### Testing Requirements

- **Unit Tests**: Protocol parsing, state machine transitions, IP validation
- **Integration Tests**: Full chat session, cancellation, concurrent requests
- **Load Tests**: 100+ concurrent connections, 1000+ requests/second
- **Regression Tests**: HTTP API unchanged

### Documentation

- Update API documentation with WebSocket endpoints
- Client SDK usage guide
- Deployment guide (local-only vs external access)
- Troubleshooting guide

### Verification & Testing Strategy

*See [Test Strategy: Non-functional & Resilience](./websocket_test_strategy.md#5-non-functional--resilience-testing-phase-5) for full methodology.*

- [x] **Memory Leak Probing**: Long-lived connections show stable heap allocation
- [x] **Backpressure Handling**: Over-buffer correctly delays/drops or scales
- [x] **Graceful Shutdown**: `SIGTERM` drains active connections properly
- [x] All metrics emitting correctly
- [x] Client SDK published and tested
- [x] 100 concurrent connections stable for 1 hour

---

## Phase 6: Connection-Scoped Media Buffer (Images/Files) [COMPLETED]

**Goal**: Support efficient binary transmission of large media assets (images, documents) without Base64 overhead.

**Duration**: 1-2 weeks
**Priority**: P3 (enhances vision/file workflows)
**Depends On**: Phase 4 (Binary Protocol Foundation)

### Deliverables

| Component | Description |
|-----------|-------------|
| media.start / media.stop | Lifecycle handlers for initializing and confirming file uploads |
| MediaHandler | Connection-scoped buffer to accumulate binary frames per stream |
| Proxy Injection | Pre-processor for chat.create replacing gateway-media://<id> with JIT Base64 |
| Media Garbage Collection | Automatic cleanup of temporary memory upon file submission or disconnect |

### Success Criteria

- Uploading a 5MB image generates memory buffer instead of WebSocket JSON frame lag.
- Calling chat.create successfully resolves the internal gateway-media:// URI.

---

## Timeline Summary

```
Week 1-2:  Phase 1 - Foundation
Week 3-5:  Phase 2 - Chat over WebSocket  
Week 6-7:  Phase 3 - Advanced Features
Week 8-10: Phase 4 - Binary Protocol & Audio
Week 11-12: Phase 5 - Production Readiness\n  Week 13-14: Phase 6 - Connection-Scoped Media Buffer

Total: ~14 weeks for full multimodel feature set
```

### Minimal Viable Product (MVP)

**Phases 1-2 only** (5 weeks):
- WebSocket connectivity
- Basic chat with streaming
- Local-only security

This enables internal testing and WebAdmin integration while advanced features are developed.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| HTTP API regression | High | Comprehensive regression tests per phase |
| Adapter AbortSignal support | Medium | Document limitation, implement partial cancellation |
| Binary protocol complexity | Medium | Extensive unit tests for frame parsing |
| Connection memory leaks | High | Load testing, heap profiling in Phase 5 |

---

## Decision Log

| Decision | Rationale | Date |
|----------|-----------|------|
| Phase 1: Local-only first | Security by default, simpler auth | 2024-01 |
| Phase 4: Binary after chat | Text chat is primary use case | 2024-01 |
| Header-prefix over frame sequences | Multiplexing safety, no state machine | 2024-01 |

---

## References

- [WebSocket Real-Time Mode Design Proposal](./websocket_realtime_mode.md)
- [RFC 6455 - WebSocket Protocol](https://tools.ietf.org/html/rfc6455)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
