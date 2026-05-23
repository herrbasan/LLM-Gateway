# WebSocket Real-Time Mode: Design Proposal

> **Status**: Proposal  
> **Target Version**: v2.1+  
> **Scope**: Optional transport layer enhancement

---

## 1. Executive Summary

Add an optional WebSocket transport (`/v1/realtime`) as an alternative to the HTTP API for use cases requiring lower latency, bi-directional communication, and persistent connections.

The HTTP API remains the **primary and recommended interface**; WebSocket mode is opt-in for specific real-time applications.

### Architectural Constraint: HTTP Unchanged

**The WebSocket implementation must not affect, modify, or interfere with the existing HTTP streaming mode.**

- HTTP `/v1/chat/completions` with `stream: true` continues to work exactly as before
- HTTP SSE (Server-Sent Events) streaming is unaffected
- No changes to HTTP request/response format
- No shared mutable state between HTTP and WebSocket handlers
- WebSocket is a **pure addition** - existing code paths remain untouched

```
┌─────────────────────────────────────────────────────────────────┐
│                        LLM Gateway                              │
│  ┌─────────────────────┐    ┌─────────────────────────────┐    │
│  │   HTTP API          │    │   WebSocket API (NEW)       │    │
│  │   (unchanged)       │    │   (local-only)              │    │
│  │                     │    │                             │    │
│  │   POST /v1/chat/    │    │   WS /v1/realtime           │    │
│  │   completions       │    │                             │    │
│  │   - SSE streaming   │    │   - JSON-RPC streaming      │    │
│  │   - X-Async header  │    │   - Bidirectional           │    │
│  │   - Ticket system   │    │   - Cancellation            │    │
│  └──────────┬──────────┘    └──────────────┬──────────────┘    │
│             │                               │                  │
│             └───────────────┬───────────────┘                  │
│                             ▼                                  │
│              ┌─────────────────────────────┐                   │
│              │     ModelRouter (shared)    │                   │
│              │     - Stateless             │                   │
│              │     - Adapter agnostic      │                   │
│              └──────────────┬──────────────┘                   │
└─────────────────────────────┼──────────────────────────────────┘
                              ▼
                   ┌─────────────────────┐
                   │   LLM Providers     │
                   └─────────────────────┘
```

**Protocol Choice**: JSON-RPC 2.0 - A well-established standard with built-in request correlation, batch support, and error handling.

---

## 2. Motivation & Use Cases

### Why WebSocket Mode?

```
HTTP Flow (Current):
┌─────────┐    TLS    ┌─────────┐    JSON    ┌─────────┐
│ Client  │ ────────► │ Gateway │ ─────────► │  LLM    │
│         │ ◄──────── │         │ ◄───────── │ Provider│
└─────────┘  ~50ms    └─────────┘  ~100ms    └─────────┘
                   ▲
                   │ New connection each request
                   └─────────────────────────────

WebSocket Flow (Proposed):
┌─────────┐    TLS    ┌─────────┐    JSON    ┌─────────┐
│ Client  │ ════════► │ Gateway │ ═════════► │  LLM    │
│         │ ◄════════ │         │ ◄───────── │ Provider│
└─────────┘  ~5ms     └─────────┘  ~100ms    └─────────┘
                   ▲
                   │ Persistent connection
                   │ Reused for all requests
                   └─────────────────────────────
```

| Use Case | HTTP Limitation | WebSocket Advantage |
|----------|----------------|---------------------|
| Voice/conversational agents | 200-500ms connection overhead per turn | Persistent connection, ~50ms latency |
| Real-time collaboration | Polling for updates | Server-push for live edits |
| Streaming with interruptions | Client can't cancel mid-stream | Bi-directional: client can send `chat.cancel` |
| High-frequency agents | Connection exhaustion | Single connection, multiplexed requests |
| Live typing indicators | Requires separate SSE connection | Unified bi-directional channel |

### Latency Impact

For a conversational agent making 10 message exchanges per minute:

| Metric | HTTP | WebSocket | Improvement |
|--------|------|-----------|-------------|
| Connection overhead | 10 × 50ms = 500ms/min | 1 × 50ms (initial) | 450ms saved |
| TLS handshake | 10 × 30ms = 300ms/min | 1 × 30ms | 270ms saved |
| **Total latency/min** | ~800ms | ~80ms | **10x reduction** |

---

## 3. Security Model: Local-Only WebSocket Access

**Critical Design Decision**: WebSocket connections are restricted to **local/internal network only**.

### Rationale

| Risk | Mitigation |
|------|------------|
| API key exposure in URLs | Eliminated - WebSocket endpoint not exposed externally |
| Connection hijacking | Reduced - Requires network-level access |
| DDoS via connection flooding | Limited - Only internal clients can connect |
| Man-in-the-middle attacks | Reduced - Local network trust boundary |

### Implementation

```javascript
// src/websocket/server.js
wss.on('connection', async (ws, req) => {
  // 1. Enforce local-only connections
  const clientIp = req.socket.remoteAddress;
  if (!isLocalNetwork(clientIp)) {
    logger.warn('Rejected external WebSocket connection', { clientIp });
    ws.close(1008, 'External connections not allowed');
    return;
  }
  
  // 2. Continue with authentication...
});

function isLocalNetwork(ip) {
  // Allow localhost, RFC 1918 private IP ranges
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  // 172.16.0.0/12 = 172.16.x.x through 172.31.x.x
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10);
    return second >= 16 && second <= 31;
  }
  return false;
}
```

### Deployment Architecture

```
External Users              Internal Services
      │                            │
      │  HTTPS Only                  │  WebSocket + HTTPS
      ▼                            ▼
┌─────────────┐              ┌─────────────┐
│   CDN/LB    │              │  LLM Gateway│
│  (no WS)    │              │  (WS local) │
└─────────────┘              └─────────────┘
                                    │
                         ┌──────────┴──────────┐
                         ▼                     ▼
                  ┌─────────────┐       ┌─────────────┐
                  │ WebAdmin    │       │ Voice Agent │
                  │ (localhost) │       │ (internal)  │
                  └─────────────┘       └─────────────┘
```

**Key Points**:
- External-facing load balancers/CDNs do not proxy WebSocket connections
- Only services running on the same machine or private network can connect
- WebAdmin (running on localhost) uses WebSocket for real-time updates
- Voice agents and internal services use WebSocket for low-latency

---

## 4. Protocol Design

### 4.1 Endpoint & Subprotocol

```
WebSocket: ws://localhost:3400/v1/realtime  (local only)
          wss://10.0.0.5:3400/v1/realtime   (internal VPN)

Subprotocol: llm-gateway-v1
```

**Design Decision**: Use **JSON-RPC 2.0** as the message protocol.

**Rationale**:
- **Standard**: Widely understood, well-specified
- **Request correlation**: Built-in `id` field for request/response matching
- **Batch support**: Multiple messages can be sent in single frame
- **Error format**: Standardized error objects
- **Ecosystem**: Native support in many languages, easy parsing

### 4.2 Message Framing (JSON-RPC 2.0)

All messages follow JSON-RPC 2.0 specification:

```typescript
// Request
{
  "jsonrpc": "2.0",
  "id": "req-123",           // Client-generated UUID for correlation
  "method": "chat.create",   // Method name
  "params": { ... }          // Method-specific payload
}

// Response (success)
{
  "jsonrpc": "2.0",
  "id": "req-123",           // Same ID as request
  "result": { ... }          // Result payload
}

// Response (error)
{
  "jsonrpc": "2.0",
  "id": "req-123",           // Same ID as request
  "error": {
    "code": -32600,
    "message": "Invalid request",
    "data": { ... }           // Optional additional data
  }
}

// Notification (no response expected)
{
  "jsonrpc": "2.0",
  "method": "system.event",  // No "id" field
  "params": { ... }
}
```

### 4.3 Connection Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │ TCP      │    │ HTTP Upgrade │    │ Auth + Session Init   │  │
│  │ Connect  │───►│ (101 Switch) │───►│ (Optional)            │  │
│  └──────────┘    └──────────────┘    └───────────────────────┘  │
│                                                │                 │
│                                                ▼                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Active Session                        │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐     │   │
│  │  │ Ping/   │  │ Request │  │ Response│  │ Push    │     │   │
│  │  │ Pong    │◄─│/Response│─►│ Stream  │─►│ Events  │     │   │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                │                 │
│                                                ▼                 │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │ Client   │    │ Server       │    │ Clean Close           │  │
│  │ Close    │───►│ Ack + Close  │───►│ (Connection released) │  │
│  └──────────┘    └──────────────┘    └───────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.4 Authentication

**Local Network Only** (Configurable): WebSocket connections are restricted by default, but this can be disabled for external access:

```javascript
// Configuration
{
  "websocket": {
    "localOnly": true,        // Default: true (secure by default)
    // Set to false + configure proper API key auth for external access
  }
}
```

**Authentication Methods** (tried in order):

1. **HTTP Upgrade Headers (Preferred)**: Access key sent via the HTTP upgrade request, protected by TLS. Rejects unauthenticated connections *before* the WebSocket handshake completes — no resources wasted.
2. **First Message**: Fallback if upgrade headers weren't provided. Must be `session.initialize`.

```javascript
// Server: Check auth during HTTP upgrade (before WebSocket handshake)
wss.handleUpgrade(req, socket, head, (ws) => {
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const accessKey = authHeader.replace('Bearer ', '');
    if (!validateAccessKey(accessKey)) {
      socket.write('HTTP/1.1 401 Unauthorized\r
\r
');
      socket.destroy();
      return;
    }
    // Mark as pre-authenticated — skip session.initialize requirement
    ws._preAuthenticated = true;
    ws._accessKey = accessKey;
  }
  wss.emit('connection', ws, req);
});
```

```javascript
// Client: Authenticate via upgrade header (preferred)
const ws = new WebSocket('ws://localhost:3400/v1/realtime', {
  headers: { 'Authorization': 'Bearer YOUR_GATEWAY_ACCESS_KEY' }
});
```

**First Message Authentication** (fallback):
```json
// Client → Server (first message after connection, only if no upgrade auth)
{
  "jsonrpc": "2.0",
  "id": "auth-1",
  "method": "session.initialize",
  "params": {
    "access_key": "YOUR_GATEWAY_ACCESS_KEY",
    "session_config": {
      "model": "gemini-flash",
      "system_prompt": "You are a helpful assistant."
    },
    "audio": {
      "input_format": "pcm16",
      "output_format": "opus",
      "sample_rate": 24000
    }
  }
}

// Server → Client
{
  "jsonrpc": "2.0",
  "id": "auth-1",
  "result": {
    "session_id": "sess_abc123",
    "expires_at": "2024-01-15T10:30:00Z",
    "capabilities": ["streaming", "compaction", "vision", "audio"],
    "audio": {
      "supported_formats": ["pcm16", "opus"],
      "supported_sample_rates": [16000, 24000, 48000],
      "max_concurrent_streams": 2
    }
  }
}
```

**Security Note**: When `localOnly: false`, the server MUST use `wss://` (WebSocket Secure). API keys sent over plaintext `ws://` to external networks are rejected.

**Connection State Enforcement**:
```javascript
// Reject any non-initialization message before authentication
if (connection.state !== 'authenticated' && message.method !== 'session.initialize') {
  this.sendError(connection, message.id, -32002, 'Session not initialized');
  return;
}
```

### 4.5 Performance Optimization: Connection-Scoped Context Buffer

**Problem**: In a stateless architecture, the client sends full message history with every request. For long-running interactive sessions (50k-100k tokens), this means:
- 300KB+ JSON payload on every turn
- Synchronous `JSON.parse()` blocks the Node.js event loop
- Latency spikes for all concurrent connections

**Solution**: WebSocket transport maintains a **connection-scoped conversation buffer** while keeping the core ModelRouter stateless.

```
┌─────────────────────────────────────────────────────────────────┐
│  HTTP Mode (Stateless - Unchanged)                              │
│  ─────────────────────────────────                              │
│  Client sends full context every request                        │
│  POST /v1/chat/completions                                      │
│  { messages: [50k tokens] } ───────────────────────► ModelRouter │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  WebSocket Mode (Connection-Scoped Buffer)                      │
│  ─────────────────────────────────────────                      │
│                                                                 │
│  Initial: session.initialize                                    │
│  { messages: [initial context] } ──► [Connection Buffer]        │
│                                      (stores context)           │
│                                                                 │
│  Subsequent: chat.create OR chat.append                         │
│  { message: "new message" } ───────► [Connection Buffer]        │
│                                      (appends to buffer)        │
│                                            │                    │
│                                            ▼                    │
│                              ┌─────────────────────┐            │
│                              │  Construct full     │            │
│                              │  context array      │            │
│                              └──────────┬──────────┘            │
│                                         ▼                       │
│                              ┌─────────────────────┐            │
│                              │  ModelRouter        │            │
│                              │  (still stateless)  │            │
│                              └─────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation**:

```javascript
// chat.append - Efficient incremental updates
{
  "jsonrpc": "2.0",
  "id": "req-456",
  "method": "chat.append",     // Alternative to chat.create
  "params": {
    "message": {                // Only the NEW message
      "role": "user",
      "content": "What about Berlin?"
    },
    "model": "gemini-flash",   // Can override session default
    "temperature": 0.7
  }
}

// Server constructs full context from connection buffer
const fullContext = [
  ...connection.conversationBuffer,  // Previously stored messages
  params.message                      // New message appended
];

// Call stateless ModelRouter with full context
const result = await this.modelRouter.routeChatCompletion({
  messages: fullContext,
  model: params.model,
  temperature: params.temperature,
  stream: true
});

// Store assistant response in buffer for next turn
connection.conversationBuffer.push(
  { role: "user", content: params.message.content },
  { role: "assistant", content: assistantResponse }
);
```

**Key Properties**:
- ✅ **ModelRouter remains stateless** - receives full context every time
- ✅ **Transport layer optimization** - connection buffer reduces JSON parsing overhead
- ✅ **Backward compatible** - `chat.create` still accepts full `messages` array
- ✅ **Client choice** - Use `chat.append` for efficiency, `chat.create` for explicit control
- ✅ **Memory bounded** - Buffer enforces a hard size limit (see below)

**Buffer Size Enforcement**:

The connection buffer has a configurable maximum size. When exceeded, the server triggers compaction or rejects the append:

```javascript
const MAX_BUFFER_TOKENS = config.websocket?.maxBufferTokens || 200000;

// Before appending to buffer
const estimatedTokens = estimateTokenCount(connection.conversationBuffer);
if (estimatedTokens >= MAX_BUFFER_TOKENS) {
  // Notify client that compaction is needed
  this.sendNotification(connection, 'system.event', {
    event_type: 'buffer_limit_reached',
    data: {
      current_tokens: estimatedTokens,
      max_tokens: MAX_BUFFER_TOKENS,
      action: 'Send chat.create with condensed history to reset buffer'
    }
  });
  this.sendError(connection, message.id, -32006, 'Buffer limit reached; send chat.create to reset');
  return;
}
```

### 4.6 Heartbeat: Native WebSocket Ping/Pong

**Design Decision**: Use WebSocket protocol-level ping/pong frames (not application-layer JSON messages).

### 4.7 Binary Protocol & Audio Streams

**Problem**: Embedding Base64 binary data in JSON creates significant overhead:
- 33% bandwidth increase (Base64 encoding)
- Large JSON parsing load (~0.5ms for 64KB audio chunks)
- High memory churn and GC pressure

**Solution**: Use **header-prefixed binary frames** — each WebSocket binary frame contains a small JSON header followed by raw binary data, separated by a null byte.

#### Why Header-Prefix Over Frame Sequences

An alternative design sends a JSON text frame followed by a binary frame ("frame sequences"). This breaks under multiplexing — concurrent streams can interleave text frames between a metadata frame and its binary partner, causing misassociation or orphaned data. Since this protocol supports up to 10 concurrent requests per connection, frame sequences are unsafe by default.

Header-prefixed frames are **atomic and self-describing** — each binary frame carries its own metadata. No state machine, no timeouts, no interleaving bugs.

#### Frame Structure

```
Binary WebSocket Frame:
┌────────────────────────────┬───┬──────────────────────────────┐
│ JSON Header (UTF-8)        │0x00│ Raw Binary Payload           │
│ {"s":"a1","t":170531...,  │   │ (PCM16, Opus, etc.)          │
│  "seq":42}                 │   │                              │
└────────────────────────────┴───┴──────────────────────────────┘
         ~50-80 bytes          1B      960+ bytes
```

The header is compact — only fields needed for routing and ordering. Format details (sample rate, channels, codec) are negotiated once at stream start, not repeated per frame.

#### Header Fields

```javascript
// Per-frame header (kept minimal for low overhead)
{
  "s": "audio-1",        // stream_id — server-assigned from audio.start
  "t": 1705312200000,    // timestamp — monotonic ms, client clock
  "seq": 42              // sequence number — for ordering and gap detection
}
```

| Field | Type | Description |
|-------|------|-------------|
| `s` | string | Stream ID (assigned by server via `audio.start` response) |
| `t` | number | Monotonic timestamp in ms (client-local clock, for playout scheduling) |
| `seq` | number | Sequence number, 0-based, monotonically increasing per stream |

#### Implementation

```javascript
// Decode: single binary frame → header + payload
function decodeBinaryFrame(data) {
  const MAX_HEADER_BYTES = 512;
  const nullIndex = data.indexOf(0);
  
  if (nullIndex === -1) {
    throw new ProtocolError('Binary frame missing null separator');
  }
  if (nullIndex > MAX_HEADER_BYTES) {
    throw new ProtocolError(`Binary header exceeds max size (${nullIndex} > ${MAX_HEADER_BYTES})`);
  }

  try {
    const headerString = data.toString('utf8', 0, nullIndex);
    const header = JSON.parse(headerString);
    const payload = data.subarray(nullIndex + 1);
    return { header, payload };
  } catch (err) {
    throw new ProtocolError('Malformed JSON header in binary frame: ' + err.message);
  }
}

// Encode: header + payload → single binary frame
function encodeBinaryFrame(header, payload) {
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const frame = Buffer.allocUnsafe(headerBuf.length + 1 + payload.length);
  headerBuf.copy(frame, 0);
  frame[headerBuf.length] = 0x00;  // null separator
  payload.copy(frame, headerBuf.length + 1);
  return frame;
}

// Message handler integration
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    try {
      const { header, payload } = decodeBinaryFrame(data);
      
      // Validate stream_id belongs to an active audio stream on this connection
      const stream = connection.audioStreams.get(header.s);
      if (!stream) {
        logger.warn('Binary frame for unknown stream', { stream_id: header.s });
        return;  // Drop — don't crash the connection
      }
      
      // Gap detection
      if (header.seq !== stream.expectedSeq) {
        logger.warn('Audio sequence gap', {
          stream_id: header.s,
          expected: stream.expectedSeq,
          received: header.seq
        });
      }
      stream.expectedSeq = header.seq + 1;
      
      processAudio(stream, header, payload);
    } catch (err) {
      logger.warn('Protocol error in binary frame', { error: err.message });
      // Optionally close connection or send error
      // this.sendError(connection, null, -32700, err.message);
    }
  } else {
    try {
      processTextMessage(JSON.parse(data));
    } catch (err) {
      logger.warn('Protocol error in text frame', { error: err.message });
    }
  }
});
```

#### Overhead Comparison

| Aspect | Base64 in JSON | Header-Prefix Binary | Improvement |
|--------|----------------|----------------------|-------------|
| **JSON parse size** | ~64KB | ~60 bytes | **99.9% smaller** |
| **Parse time** | ~0.5ms | <0.01ms | **50x+ faster** |
| **Bandwidth overhead** | +33% | ~5% (header on 960B frame) | **6x less** |
| **Memory churn** | High | Low | **Less GC pressure** |
| **Multiplexing safe** | Yes | Yes | **Both safe** |
| **Atomic delivery** | Yes | Yes | **No state machine** |

#### Audio Stream Lifecycle

Audio streams have an explicit lifecycle — the server assigns stream IDs and negotiates format.

```json
// 1. Client requests audio stream
{
  "jsonrpc": "2.0",
  "id": "req-a1",
  "method": "audio.start",
  "params": {
    "request_id": "req-123",
    "direction": "duplex"
  }
}

// 2. Server confirms with server-assigned stream_id and negotiated format
{
  "jsonrpc": "2.0",
  "id": "req-a1",
  "result": {
    "stream_id": "audio-1",
    "input_format": "pcm16",
    "output_format": "opus",
    "sample_rate": 24000,
    "channels": 1,
    "frame_duration_ms": 20
  }
}

// 3. Client/server exchange binary frames using stream_id "audio-1"
// (binary frames as described above)

// 4. Either side can signal VAD events (voice activity detection)
{
  "jsonrpc": "2.0",
  "method": "audio.vad",
  "params": {
    "stream_id": "audio-1",
    "event": "speech_start"    // or "speech_end"
  }
}

// 5. Client or server stops the stream
{
  "jsonrpc": "2.0",
  "id": "req-a2",
  "method": "audio.stop",
  "params": {
    "stream_id": "audio-1"
  }
}

// 6. Server confirms and reports stats
{
  "jsonrpc": "2.0",
  "id": "req-a2",
  "result": {
    "stream_id": "audio-1",
    "frames_received": 1500,
    "frames_sent": 1200,
    "duration_ms": 30000
  }
}
```

**Key rules:**
- `stream_id` is **server-assigned** — clients cannot fabricate stream IDs
- Binary frames with unknown `stream_id` are dropped (logged, not fatal)
- Format is negotiated once at `audio.start`, not repeated per frame
- `audio.stop` cancels any pending processing for that stream

#### Audio Format Negotiation

Supported formats and preferences are declared during session initialization (see Section 4.4). The server selects the best match:

| Format | Bandwidth (24kHz mono) | Latency | Use Case |
|--------|------------------------|---------|----------|
| `pcm16` | 48 KB/s | Lowest | Local/localhost, no CPU overhead |
| `opus` | 3-6 KB/s | Low (+2ms encode) | Networked, bandwidth-constrained |

If the client requests a format the server doesn't support, `audio.start` returns an error with available alternatives.

#### Backpressure

Binary frames respect the same backpressure mechanism as text frames:

```javascript
async sendAudioFrame(ws, streamId, seq, timestamp, payload) {
  if (ws.bufferedAmount > this.backpressureHighWater) {
    await this.waitForDrain(ws);
  }
  
  const frame = encodeBinaryFrame(
    { s: streamId, t: timestamp, seq },
    payload
  );
  ws.send(frame);
}
```

#### Error Handling

```javascript
// Unknown stream — drop frame, don't kill connection
if (!connection.audioStreams.has(header.s)) {
  logger.warn('Binary frame for unknown stream', { stream_id: header.s });
  return;
}

// Missing null separator — protocol error
if (data.indexOf(0) === -1) {
  this.sendError(connection, null, -32700,
    'Binary frame missing null separator');
  return;
}

// Sequence gap — log for diagnostics, continue processing
if (header.seq !== stream.expectedSeq) {
  metrics.increment('ws_audio_sequence_gaps_total');
}
```

### 4.8 Connection-Scoped Media Buffer (Images/Files)

**Problem**: Embedding large files/images as Base64 JSON strings blocks the connection, increases size by 33%, and impacts Node.js event loop parsing time.

**Solution**: Connection-scoped media buffers using multiplexed header-prefixed binary frames (re-using the architecture created for the audio streams). 

#### Implementation Strategy

1. **Declare intent**: media.start. Client assigns a desired metadata payload via a new standard JSON-RPC command.
2. **Stream Binary Data**: The client transmits frames.
3. **Just-In-Time Assembly**: Once completed (or while streaming), the client triggers chat.create offering an internal URL schema pointing to the buffer (gateway-media://<stream_id>). 
4. **Proxy Mapping**: ChatHandler maps gateway-media://... references to the accumulated raw buffer, automatically mapping it seamlessly into Native Base64 arrays required by the stateless Adapter providers.

--- 

### 4.9 Message Granularity

**For High Interactivity**: Ensure minimal buffering of upstream chunks.

```javascript
// Adapter yields tokens as they arrive
// WebSocket handler forwards immediately (no batching)
for await (const chunk of result.generator) {
  // Each chunk = 1-4 characters for character-level streaming
  // OR 1 word for word-level streaming
  
  this.sendNotification(connection, 'chat.delta', {
    request_id: requestId,
    choices: [{
      index: 0,
      delta: { content: chunk }  // Minimal buffering
    }]
  }, requestId);
}
```

**Configuration**:
```javascript
{
  "websocket": {
    "streaming": {
      "bufferMs": 0,        // 0 = no buffering, immediate forward
      "maxChunkSize": 16    // Max characters per chunk (for word boundary)
    }
  }
}
```

**Rationale**:
- Built into WebSocket protocol (opcodes 0x09 ping, 0x0A pong)
- Handled automatically by browsers and `ws` library
- No client SDK code needed
- More efficient than JSON messages

```javascript
// Server-side (using 'ws' library)
const wss = new WebSocketServer({
  server: httpServer,
  path: '/v1/realtime',
  // Native ping/pong configuration
  clientTracking: true,
});

// Enable automatic ping/pong
wss.on('connection', (ws) => {
  // 'ws' library handles pong responses automatically
  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// Server sends ping every 30 seconds
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();  // Dead connection
    }
    ws.isAlive = false;
    ws.ping();  // Native ping frame
  });
}, 30000);
```

### 4.10 Message Types

#### Client → Server

| Method | Description | Params |
|--------|-------------|--------|
| `session.initialize` | Authenticate and initialize session | `{ access_key, session_config, audio? }` |
| `chat.create` | Start chat completion (full context) | Same as HTTP `/v1/chat/completions` body |
| `chat.append` | Append message to conversation (efficient) | `{ message, model?, ... }` |
| `audio.start` | Open an audio stream (server assigns stream_id) | `{ request_id, direction }` |
| `audio.stop` | Close an audio stream | `{ stream_id }` |
| `audio.vad` | Voice activity detection event | `{ stream_id, event }` |
| *(binary frame)* | Audio data (header-prefixed binary) | Header: `{ s, t, seq }` + raw payload |
| `chat.cancel` | Cancel in-flight request | `{ request_id }` |
| `settings.update` | Update per-connection settings | `{ thinkingStrip }` |

#### Server → Client

| Method | Description | Params |
|--------|-------------|--------|
| `session.initialized` | Authentication successful | `{ session_id, capabilities }` |
| `chat.accepted` | Request received, processing | `{ request_id, estimated_chunks }` |
| `chat.delta` | Token/stream chunk (notification) | `{ request_id, choices }` |
| `chat.progress` | Pre-stream phase progress (notification) | `{ request_id, phase, detail }` |
| `chat.compaction` | Context compaction progress (notification) | `{ request_id, chunk, total }` |
| `chat.done` | Completion finished (notification) | `{ request_id, choices, usage, model }` |
| `chat.error` | Error occurred (notification) | `{ request_id, code, message, data }` |
| `audio.vad` | Voice activity detection event | `{ stream_id, event }` |
| *(binary frame)* | Audio data (header-prefixed binary) | Header: `{ s, t, seq }` + raw payload |
| `system.event` | Gateway-wide events (notification) | `{ event_type, data }` |

### 4.11 Streaming Protocol: JSON-RPC Compliance

**Design Decision**: Streaming uses JSON-RPC **notifications** (no `id` at top level) with `request_id` inside `params` for correlation.

JSON-RPC 2.0 specifies that a notification is a request without an `id` member, and that a response has `result` or `error` but no `method`. Streaming chunks fit neither pattern — they are server-initiated messages correlated to an earlier request. Rather than violate the spec by placing both `id` and `method` on the same message, we use spec-compliant notifications and carry correlation inside `params.request_id`.

```json
// 1. Client initiates chat (standard JSON-RPC request)
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "method": "chat.create",
  "params": {
    "model": "gemini-flash",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is the capital of France?"}
    ],
    "temperature": 0.7
  }
}

// 2. Server acknowledges (standard JSON-RPC response — the ONLY response for this id)
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "result": {
    "accepted": true
  }
}

// 3. Server reports pre-stream progress (notification — no top-level id)
{
  "jsonrpc": "2.0",
  "method": "chat.progress",
  "params": {
    "request_id": "req-123",
    "phase": "routing",
    "detail": "Resolved to gemini-flash via openai adapter"
  }
}

// 4. Server streams tokens (notification — request_id in params)
{
  "jsonrpc": "2.0",
  "method": "chat.delta",
  "params": {
    "request_id": "req-123",
    "choices": [{"index": 0, "delta": {"content": "The"}}]
  }
}

// 5. Server streams more tokens
{
  "jsonrpc": "2.0",
  "method": "chat.delta",
  "params": {
    "request_id": "req-123",
    "choices": [{"index": 0, "delta": {"content": " capital of France is Paris."}}]
  }
}

// 6. Server signals completion (notification)
{
  "jsonrpc": "2.0",
  "method": "chat.done",
  "params": {
    "request_id": "req-123",
    "choices": [{
      "index": 0,
      "message": {"role": "assistant", "content": "The capital of France is Paris."},
      "finish_reason": "stop"
    }],
    "usage": {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28},
    "timing": {
      "first_token_ms": 142,
      "total_ms": 680
    }
  }
}
```

**Concurrent Request Example** — `request_id` in params disambiguates interleaved streams:
```json
// Client sends two requests
{ "jsonrpc": "2.0", "id": "req-A", "method": "chat.create", "params": {...} }
{ "jsonrpc": "2.0", "id": "req-B", "method": "chat.create", "params": {...} }

// Server interleaves notifications — request_id tells client which stream
{ "jsonrpc": "2.0", "method": "chat.delta", "params": { "request_id": "req-A", ... } }
{ "jsonrpc": "2.0", "method": "chat.delta", "params": { "request_id": "req-B", ... } }
{ "jsonrpc": "2.0", "method": "chat.done",  "params": { "request_id": "req-A", ... } }
{ "jsonrpc": "2.0", "method": "chat.done",  "params": { "request_id": "req-B", ... } }
```

**Error During Streaming** — mid-stream errors are also notifications:
```json
{
  "jsonrpc": "2.0",
  "method": "chat.error",
  "params": {
    "request_id": "req-123",
    "code": -32004,
    "message": "Upstream provider error",
    "data": {
      "chunks_sent": 50,
      "partial_content": "The capital of France is",
      "retryable": true
    }
  }
}
```

---

## 5. Feature Parity with HTTP API

### 5.1 Capability Mapping

| HTTP Feature | WebSocket Equivalent |
|--------------|----------------------|
| `POST /v1/chat/completions` | `chat.create` message |
| `stream: true` | Implicit - all responses stream |
| `X-Async: true` | Not needed - all requests are async by nature |
| SSE compaction events | `chat.compaction` messages |
| `GET /v1/models` | Included in `session.initialized` response |
| `/v1/system/events` | Subscribe via `system.event` messages |

### 5.2 Context Compaction Handling

```json
// Server detects context window approaching limit
{
  "jsonrpc": "2.0",
  "method": "system.event",
  "params": {
    "event_type": "compaction_required",
    "data": {
      "reason": "context_window_near_limit",
      "current_tokens": 7800,
      "window_limit": 8192,
      "recommended_action": "resend_messages_with_summary"
    }
  }
}

// Client handles compaction internally (preferred approach)
{
  "jsonrpc": "2.0",
  "id": "req-456",
  "method": "chat.create",
  "params": {
    "messages": [
      // Condensed conversation history
      {"role": "system", "content": "...", "summary": true},
      {"role": "user", "content": "Latest message..."}
    ]
  }
}
```

### 5.3 Error Handling & Reconnection Strategy

```json
// Recoverable errors - Client retries with backoff
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "error": {
    "code": -32001,
    "message": "Rate limit exceeded",
    "data": {"retry_after_ms": 5000}
  }
}

// Session errors - Client reinitializes
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "error": {
    "code": -32002,
    "message": "Session has expired",
    "data": {"reason": "max_idle_time_exceeded"}
  }
}

// Protocol errors - Client disconnects
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "error": {
    "code": -32600,
    "message": "Invalid message format"
  }
}

// Upstream failure after partial stream (notification with request_id)
{
  "jsonrpc": "2.0",
  "method": "chat.error",
  "params": {
    "request_id": "req-123",
    "code": -32004,
    "message": "Upstream provider error",
    "data": { 
      "chunks_sent": 50,
      "retryable": true
    }
  }
}
```

---

## 6. Implementation Architecture

### 6.1 Server Structure & HTTP Isolation

The WebSocket implementation is **completely isolated** from HTTP handlers:

```
src/
├── routes/                    # HTTP API (UNCHANGED)
│   ├── chat.js               # HTTP streaming - no modifications
│   ├── models.js             # HTTP models endpoint
│   └── ...                   # Other HTTP routes
│
├── websocket/                 # NEW: WebSocket only
│   ├── server.js             # WebSocket server setup
│   ├── connection.js         # Per-connection state machine
│   ├── connection-manager.js # Connection pool management
│   ├── protocol.js           # Message encoding/decoding (JSON-RPC)
│   ├── handlers/
│   │   ├── auth.js
│   │   ├── chat.js           # Calls ModelRouter (same as HTTP)
│   │   └── system.js
│   ├── backpressure.js       # Flow control
│   ├── request-state.js      # Request lifecycle management
│   └── errors.js             # Protocol error definitions
```

**Key Isolation Principles:**

1. **Separate Entry Points**: HTTP and WebSocket have different route handlers
2. **No Shared Mutable State**: WebSocket connection state is isolated
3. **Same Business Logic**: Both use `ModelRouter.routeChatCompletion()` - the transport layer is transparent
4. **Independent Configuration**: WebSocket settings don't affect HTTP behavior
5. **No Cross-Contamination**: HTTP streaming SSE continues exactly as before

### 6.2 Integration with Express Server

```javascript
// src/websocket/server.js
import { WebSocketServer } from 'ws';
import { ConnectionManager } from './connection-manager.js';
import { MessageHandler } from './handlers/message.js';

export function createWebSocketServer(httpServer, config, modelRouter) {
  const wss = new WebSocketServer({ 
    server: httpServer,
    path: '/v1/realtime',
    maxPayload: config.websocket?.maxMessageSizeBytes || 1024 * 1024,
    perMessageDeflate: true
  });

  const connectionManager = new ConnectionManager(config);
  const messageHandler = new MessageHandler(modelRouter, connectionManager);

  // Native ping/pong heartbeat
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, config.websocket?.pingIntervalMs || 30000);

  wss.on('connection', async (ws, req) => {
    // 1. Enforce local-only connections
    const clientIp = req.socket.remoteAddress;
    if (!isLocalNetwork(clientIp)) {
      logger.warn('Rejected external WebSocket connection', { clientIp });
      ws.close(1008, 'External connections not allowed');
      return;
    }
    
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    // 2. Create connection context
    const connection = connectionManager.create(ws, {
      remoteAddress: clientIp,
    });
    
    // 3. Set up message handlers
    ws.on('message', (data) => messageHandler.handle(connection, data));
    ws.on('close', (code, reason) => connectionManager.remove(connection.id));
    ws.on('error', (error) => {
      logger.error('WebSocket error', { connectionId: connection.id, error });
      connectionManager.remove(connection.id);
    });
    
    // 4. Send welcome message
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'system.event',
      params: {
        event_type: 'connected',
        data: {
          connection_id: connection.id,
          capabilities: ['streaming', 'compaction', 'vision', 'tools']
        }
      }
    }));
  });

  return { wss, pingInterval };
}

function isLocalNetwork(ip) {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10);
    return second >= 16 && second <= 31;
  }
  return false;
}
```

### 6.3 Connection Manager

```javascript
// src/websocket/connection-manager.js
export class ConnectionManager {
  constructor(config) {
    this.connections = new Map();
    this.clientConnections = new Map();
    this.config = config.websocket || {};
  }
  
  create(ws, metadata) {
    const connection = {
      id: crypto.randomUUID(),
      ws,
      remoteAddress: metadata.remoteAddress,
      state: 'connecting',        // 'connecting' | 'authenticated' | 'closing'
      createdAt: new Date(),
      lastActivityAt: new Date(),
      activeRequests: new Map(),  // requestId → RequestState
    };
    
    // Check connection limits
    if (this.connections.size >= (this.config.maxGlobalConnections || 100)) {
      throw new Error('Global connection limit exceeded');
    }
    
    this.connections.set(connection.id, connection);
    this.setupIdleTimeout(connection);
    
    return connection;
  }
  
  remove(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    // Cancel any active requests
    for (const [requestId, requestState] of connection.activeRequests) {
      this.cancelRequest(connectionId, requestId);
    }
    
    this.connections.delete(connectionId);
  }
  
  setupIdleTimeout(connection) {
    const timeout = setTimeout(() => {
      if (connection.activeRequests.size === 0) {
        connection.ws.close(1008, 'Idle timeout');
      }
    }, this.config.idleTimeoutMs || 300000);
    
    connection.ws.once('close', () => clearTimeout(timeout));
  }
}
```

### 6.4 Request State Machine

```typescript
// src/websocket/request-state.js

export const RequestState = {
  PENDING: 'pending',        // Received, not yet sent to upstream
  PROCESSING: 'processing',  // Sent to upstream, receiving deltas
  COMPLETED: 'completed',    // Final response sent
  CANCELLED: 'cancelled',    // Cancelled by client
  FAILED: 'failed'           // Error occurred
};

export class RequestContext {
  constructor(id, params) {
    this.id = id;
    this.params = params;
    this.state = RequestState.PENDING;
    this.startTime = Date.now();
    this.chunksSent = 0;
    this.abortController = new AbortController();
  }
  
  transition(newState) {
    const validTransitions = {
      [RequestState.PENDING]: [RequestState.PROCESSING, RequestState.CANCELLED],
      [RequestState.PROCESSING]: [RequestState.COMPLETED, RequestState.CANCELLED, RequestState.FAILED],
      [RequestState.CANCELLED]: [],
      [RequestState.COMPLETED]: [],
      [RequestState.FAILED]: []
    };
    
    if (!validTransitions[this.state].includes(newState)) {
      throw new Error(`Invalid state transition: ${this.state} → ${newState}`);
    }
    
    this.state = newState;
  }
  
  cancel() {
    this.transition(RequestState.CANCELLED);
    this.abortController.abort();
  }
}
```

### 6.5 Message Handler with Resource Guards

```javascript
// src/websocket/handlers/message.js
export class MessageHandler {
  constructor(modelRouter, connectionManager, config) {
    this.modelRouter = modelRouter;
    this.connectionManager = connectionManager;
    this.config = config.websocket || {};
    this.maxConcurrentRequests = this.config.maxConcurrentRequestsPerConnection || 10;
    this.backpressureHighWater = this.config.backpressure?.highWaterMark || 256 * 1024;
  }
  
  async handle(connection, data) {
    connection.lastActivityAt = new Date();
    
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.sendError(connection, null, -32700, 'Parse error');
      return;
    }
    
    // Validate JSON-RPC structure
    if (message.jsonrpc !== '2.0') {
      this.sendError(connection, message.id, -32600, 'Invalid Request');
      return;
    }
    
    // Enforce authentication state
    if (connection.state !== 'authenticated' && message.method !== 'session.initialize') {
      this.sendError(connection, message.id, -32002, 'Session not initialized');
      return;
    }
    
    // Route to handler
    try {
      switch (message.method) {
        case 'session.initialize':
          await this.handleSessionInit(connection, message);
          break;
        case 'chat.create':
        case 'chat.append':
          await this.handleChatCreate(connection, message);
          break;
        case 'chat.cancel':
          await this.handleChatCancel(connection, message);
          break;
        case 'settings.update':
          await this.handleSettingsUpdate(connection, message);
          break;
        default:
          this.sendError(connection, message.id, -32601, 'Method not found');
      }
    } catch (error) {
      logger.error('Message handling error', { method: message.method, error });
      this.sendError(connection, message.id, -32603, 'Internal error');
    }
  }
  
  async handleChatCreate(connection, message) {
    const requestId = message.id;
    
    // ENFORCE: Concurrent request limit
    if (connection.activeRequests.size >= this.maxConcurrentRequests) {
      this.sendError(connection, requestId, -32003, 
        `Concurrent request limit exceeded (${this.maxConcurrentRequests})`);
      return;
    }
    
    // Create request context with state machine + timeout
    const requestContext = new RequestContext(
      requestId, message.params,
      this.config.requestTimeoutMs || 120000
    );
    connection.activeRequests.set(requestId, requestContext);
    
    // Auto-cleanup on timeout
    requestContext.abortController.signal.addEventListener('abort', () => {
      if (requestContext.state === RequestState.FAILED) {
        this.sendNotification(connection, 'chat.error', {
          request_id: requestId,
          code: -32008,
          message: 'Request timeout'
        });
        connection.activeRequests.delete(requestId);
      }
    });
    
    // Send acceptance response (the one JSON-RPC response for this request id)
    this.sendResponse(connection, requestId, { accepted: true });
    
    try {
      // Emit progress: routing phase
      this.sendNotification(connection, 'chat.progress', {
        request_id: requestId,
        phase: 'routing',
        detail: `Resolving model: ${message.params.model}`
      });
      
      // Route through existing ModelRouter
      // NOTE: Upstream cancellation requires ModelRouter + adapters to accept
      // and forward the AbortSignal to their fetch() calls. Until that
      // prerequisite work is done, cancellation stops chunk forwarding
      // but does NOT abort the upstream HTTP request.
      const result = await this.modelRouter.routeChatCompletion({
        ...message.params,
        stream: true,
        signal: requestContext.abortController.signal
      });
      
      // Emit progress: context info
      if (result.context) {
        this.sendNotification(connection, 'chat.progress', {
          request_id: requestId,
          phase: 'context',
          detail: `Window: ${result.context.window_size}, Used: ${result.context.used_tokens}`,
          data: result.context
        });
      }
      
      if (result.stream) {
        requestContext.transition(RequestState.PROCESSING);
        
        for await (const chunk of result.generator) {
          // Check if cancelled or timed out
          if (requestContext.state !== RequestState.PROCESSING) {
            break;
          }
          
          // Backpressure: wait if socket write buffer is full
          if (connection.ws.bufferedAmount >= this.backpressureHighWater) {
            await this.waitForDrain(connection.ws);
          }
          
          // Track first token latency
          requestContext.recordFirstToken();
          
          // Send chunk as notification (spec-compliant: no top-level id)
          this.sendNotification(connection, 'chat.delta', {
            request_id: requestId,
            ...chunk
          });
          
          requestContext.chunksSent++;
        }
      }
      
      if (requestContext.state === RequestState.PROCESSING) {
        requestContext.transition(RequestState.COMPLETED);
        this.sendNotification(connection, 'chat.done', {
          request_id: requestId,
          result,
          timing: {
            first_token_ms: requestContext.firstTokenLatencyMs,
            total_ms: requestContext.totalLatencyMs
          }
        });
      }
      
    } catch (error) {
      if (requestContext.state !== RequestState.FAILED) {
        requestContext.transition(RequestState.FAILED);
      }
      
      // Send error as notification (correlated by request_id)
      this.sendNotification(connection, 'chat.error', {
        request_id: requestId,
        code: -32000,
        message: error.message,
        data: { chunks_sent: requestContext.chunksSent }
      });
    } finally {
      connection.activeRequests.delete(requestId);
    }
  }
  
  async handleChatCancel(connection, message) {
    const requestId = message.params?.request_id;
    const request = connection.activeRequests.get(requestId);
    
    if (!request) {
      this.sendError(connection, message.id, -32005, 'Request not found');
      return;
    }
    
    // Only cancel if in cancellable state
    if (request.state === RequestState.PENDING || 
        request.state === RequestState.PROCESSING) {
      request.cancel();
      
      // Send cancellation confirmation as notification
      this.sendNotification(connection, 'chat.done', {
        request_id: requestId,
        cancelled: true,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'cancelled'
        }],
        timing: {
          first_token_ms: request.firstTokenLatencyMs,
          total_ms: request.totalLatencyMs
        }
      });
    }
    
    // Respond to the cancel request itself
    this.sendResponse(connection, message.id, { cancelled: true, request_id: requestId });
    connection.activeRequests.delete(requestId);
  }
  
  // JSON-RPC response (with id, result/error, no method)
  sendResponse(connection, id, result) {
    if (connection.ws.readyState !== 1) return;
    connection.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result
    }));
  }
  
  // JSON-RPC notification (no id, has method) — spec-compliant
  sendNotification(connection, method, params) {
    if (connection.ws.readyState !== 1) return;
    connection.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    }));
  }
  
  sendError(connection, id, code, message) {
    if (connection.ws.readyState !== 1) return;
    connection.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message }
    }));
  }
  
  async waitForDrain(ws) {
    const LOW_WATER_MARK = 64 * 1024;
    
    if (ws.bufferedAmount < LOW_WATER_MARK) return;
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Backpressure timeout'));
      }, 30000);
      
      // Use send callback + polling fallback to avoid missing drain events
      const poll = setInterval(() => {
        if (ws.bufferedAmount < LOW_WATER_MARK) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
      
      // Also listen for drain as primary signal
      const onDrain = () => {
        if (ws.bufferedAmount < LOW_WATER_MARK) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve();
        }
      };
      ws.once('drain', onDrain);
    });
  }
}
```

### 6.6 Backpressure Handling

```javascript
// src/websocket/backpressure.js
export class BackpressureHandler {
  constructor(ws, config) {
    this.ws = ws;
    this.HIGH_WATER_MARK = config.highWaterMark || 256 * 1024;  // 256KB
    this.LOW_WATER_MARK = config.lowWaterMark || 64 * 1024;    // 64KB
  }
  
  canSend() {
    return this.ws.bufferedAmount < this.HIGH_WATER_MARK;
  }
  
  async waitForDrain() {
    if (this.ws.bufferedAmount < this.LOW_WATER_MARK) return;
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Backpressure timeout'));
      }, 30000);
      
      // Polling fallback: drain events can be missed if the TCP write
      // buffer empties synchronously between the bufferedAmount check
      // and the listener registration. Poll at 50ms as safety net.
      const poll = setInterval(() => {
        if (this.ws.bufferedAmount < this.LOW_WATER_MARK) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
      
      // Primary signal: drain event from the ws library
      const onDrain = () => {
        if (this.ws.bufferedAmount < this.LOW_WATER_MARK) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve();
        }
      };
      this.ws.once('drain', onDrain);
    });
  }
}
```

---

## 7. Graceful Shutdown

Persistent WebSocket connections require explicit shutdown handling. When the gateway restarts, all connections die — unlike HTTP where each request is independent.

```javascript
// src/websocket/server.js
export function createWebSocketShutdown(wss, connectionManager, pingInterval) {
  return async function gracefulShutdown(reason = 'server_restart') {
    // 1. Stop accepting new connections
    wss.close();
    clearInterval(pingInterval);
    
    // 2. Notify all connected clients
    for (const [id, connection] of connectionManager.connections) {
      try {
        connection.ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'system.event',
          params: {
            event_type: 'shutdown',
            data: {
              reason,
              reconnect_after_ms: 5000,
              message: 'Server is shutting down. Reconnect shortly.'
            }
          }
        }));
      } catch { /* connection may already be dead */ }
    }
    
    // 3. Wait for active requests to finish (with timeout)
    const DRAIN_TIMEOUT_MS = 10000;
    const drainStart = Date.now();
    
    while (connectionManager.hasActiveRequests() && 
           Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 250));
    }
    
    // 4. Close all connections with "Going Away" code
    for (const [id, connection] of connectionManager.connections) {
      connection.ws.close(1001, 'Server shutting down');
    }
    
    connectionManager.connections.clear();
  };
}
```

**Integration with process signals:**
```javascript
// src/server.js (addition)
const { shutdown } = createWebSocketShutdown(wss, connectionManager, pingInterval);

process.on('SIGTERM', async () => {
  await shutdown('sigterm');
  process.exit(0);
});
```

---

## 8. Configuration

```json
{
  "websocket": {
    "enabled": true,
    "path": "/v1/realtime",
    "localOnly": true,
    "maxGlobalConnections": 100,
    "maxConnectionsPerClient": 5,
    "maxConcurrentRequestsPerConnection": 10,
    "maxBufferTokens": 200000,
    "idleTimeoutMs": 300000,
    "requestTimeoutMs": 120000,
    "shutdownDrainMs": 10000,
    "pingIntervalMs": 30000,
    "maxMessageSizeBytes": 1048576,
    "perMessageDeflate": true,
    "backpressure": {
      "highWaterMark": 262144,
      "lowWaterMark": 65536
    },
    "streaming": {
      "bufferMs": 0,
      "adaptiveBatching": true,
      "adaptiveBatchThreshold": 20,
      "maxBatchMs": 50
    },
    "audio": {
      "supportedFormats": ["pcm16", "opus"],
      "supportedSampleRates": [16000, 24000, 48000],
      "defaultSampleRate": 24000,
      "maxConcurrentStreamsPerConnection": 2,
      "frameDurationMs": 20
    }
  },
  "models": {
    "gemini-flash": {
      "type": "chat",
      "capabilities": {
        "streaming": true,
        "websocket": true
      }
    }
  }
}
```

**Adaptive Batching**: When `adaptiveBatching` is enabled, the gateway monitors chunk arrival rate. Below the threshold (e.g., 20 chunks/sec for interactive typing), chunks are forwarded immediately. Above it (e.g., bulk code generation), chunks are batched into frames up to `maxBatchMs` to reduce WebSocket frame overhead.

### Environment Variables

```bash
# WebSocket Server
WS_ENABLED=true
WS_LOCAL_ONLY=true              # Set to false for external access
WS_MAX_GLOBAL_CONNECTIONS=100
WS_MAX_CONCURRENT_REQUESTS_PER_CONNECTION=10
WS_MAX_BUFFER_TOKENS=200000
WS_ADAPTIVE_BATCHING=true       # Batch chunks during burst generation
WS_IDLE_TIMEOUT_MS=300000
WS_REQUEST_TIMEOUT_MS=120000
WS_SHUTDOWN_DRAIN_MS=10000
WS_PING_INTERVAL_MS=30000
```

---

## 9. Client SDK Design

```javascript
// JavaScript client example
const client = new GatewayClient({
  baseUrl: 'ws://localhost:3400',
  mode: 'websocket',  // or 'http'
  accessKey: 'YOUR_GATEWAY_ACCESS_KEY'
});

// Event-based streaming
const stream = client.chatStream({
  model: 'gemini-flash',
  messages: [{ role: 'user', content: 'Tell me a story' }]
});

stream.on('delta', (delta) => {
  process.stdout.write(delta.choices[0].delta.content);
});

stream.on('done', (result) => {
  console.log('
Total tokens:', result.usage.total_tokens);
  console.log('First token:', result.timing.first_token_ms, 'ms');
});

stream.on('progress', (progress) => {
  console.log(`[${progress.phase}] ${progress.detail}`);
});

stream.on('error', (error) => {
  console.error('Stream error:', error);
});

// Cancel mid-stream
stream.cancel();

// Promise-based (simpler for single requests)
const result = await client.chat({
  model: 'gemini-flash',
  messages: [{ role: 'user', content: 'Hello!' }]
});
console.log(result);

// Auto-reconnection built-in
client.on('reconnect', (attempt) => {
  console.log(`Reconnecting... attempt ${attempt}`);
});

client.on('disconnected', (code, reason) => {
  console.log(`Disconnected: ${code} ${reason}`);
});
```

### Reconnection Strategy

```
Attempt  | Delay (with jitter)  | Cumulative
---------|----------------------|------------
1        | ~1s                  | 1s
2        | ~2s                  | 3s
3        | ~4s                  | 7s
4        | ~8s                  | 15s
5        | ~16s                 | 31s
...      | capped at 30s        | capped
max      | 30s                  | ~120s total before failure
```

---

## 10. Security Considerations

### 9.1 Security Checklist

| Control | Implementation |
|---------|---------------|
| ✅ Local-only access | IP whitelist (localhost, private ranges) |
| ✅ Authentication | Required before any operations |
| ✅ Connection limits | Per-client and global limits |
| ✅ Message size limits | Max 1MB per message |
| ✅ Request limits | Max 10 concurrent per connection |
| ✅ Memory protection | Max 50 chunks buffered per stream |
| ✅ Idle timeouts | 5 minute idle timeout |
| ✅ Input validation | JSON-RPC schema validation |

### 9.2 Deployment Security

```
Production Deployment (Default - Local Only):

┌─────────────────────────────────────────────────────────────┐
│                        Internet                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ HTTPS only
┌─────────────────────────────────────────────────────────────┐
│                    Reverse Proxy / CDN                      │
│              (WebSocket connections blocked)                │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    DMZ / Private Network                    │
│  ┌─────────────┐              ┌─────────────────────────┐  │
│  │ WebAdmin    │──────────────►│  LLM Gateway          │  │
│  │ (localhost) │  WebSocket   │  - HTTP: 0.0.0.0:3400 │  │
│  └─────────────┘              │  - WS: localhost:3400   │  │
│                               └─────────────────────────┘  │
│                                          │                  │
│                                          ▼ HTTPS            │
│                               ┌─────────────────────────┐  │
│                               │  LLM Providers          │  │
│                               └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Optional: External WebSocket Access (WS_LOCAL_ONLY=false)

┌─────────────────────────────────────────────────────────────┐
│                        Internet                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ WSS (WebSocket Secure)
┌─────────────────────────────────────────────────────────────┐
│                    LLM Gateway                              │
│  - HTTP: 0.0.0.0:3400                                      │
│  - WS: 0.0.0.0:3400 (with API key auth)                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 11. Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `ws_connections_active` | Gauge | Currently active WebSocket connections |
| `ws_connections_total` | Counter | Total connections accepted |
| `ws_connections_rejected` | Counter | Rejected connections (external IP) |
| `ws_first_token_latency_seconds` | Histogram | Time to first token (from `RequestContext.firstTokenLatencyMs`) |
| `ws_request_duration_seconds` | Histogram | Total request duration (from `RequestContext.totalLatencyMs`) |
| `ws_errors_total` | Counter | Total errors by error code |
| `ws_reconnects_total` | Counter | Total client reconnections |
| `ws_backpressure_events_total` | Counter | Backpressure activation count |
| `ws_request_cancelled_total` | Counter | Cancelled requests |
| `ws_request_timeout_total` | Counter | Requests that hit the timeout limit |
| `ws_buffer_tokens_current` | Gauge | Current token count in connection buffers |

---

## 12. Prerequisites & Migration Notes

### Upstream Cancellation

The `chat.cancel` feature currently stops forwarding chunks to the client, but **does not abort the upstream HTTP request** to the LLM provider. Full cancellation requires:

1. `ModelRouter.routeChatCompletion()` must accept an `AbortSignal` parameter
2. Each adapter's `streamComplete()` must forward the signal to its `fetch()` call
3. The async generator must check `signal.aborted` between yields

Without this work, cancellation saves client bandwidth but not upstream API costs. This should be implemented before or alongside the WebSocket feature.

### Adapter Signal Support

Adapters that support `AbortSignal` can abort the upstream connection. Those that don't will continue to completion in the background. The gateway should log when cancellation is "soft" (client-side only) vs "hard" (upstream aborted).

---

## 13. Summary

This design:
- ✅ **HTTP API completely unchanged** - no modifications to existing endpoints
- ✅ Uses **JSON-RPC 2.0** for standard message framing (spec-compliant: notifications for streaming, responses for acknowledgments)
- ✅ **Local-only by default** with optional external access (RFC 1918 compliant IP validation)
- ✅ **Upgrade-header authentication** - rejects before handshake, TLS-protected
- ✅ **Connection-scoped context buffer** with hard size limits and compaction triggers
- ✅ **`chat.append`** for efficient incremental updates (vs full context)
- ✅ **Multiplexed binary protocol** - frame sequences for audio/video (no Base64 overhead)
- ✅ **Stateless business logic** - ModelRouter unchanged, transport layer optimized
- ✅ **`chat.progress` notifications** - real-time visibility into routing, compaction, and context phases
- ✅ **First-token latency tracking** - `RequestContext` records and reports TTFT
- ✅ **Request timeouts** - auto-fail requests that exceed `requestTimeoutMs`
- ✅ **Resource guards** (concurrent limits, backpressure with drain+polling fallback)
- ✅ **Request state machine** with proper cancellation and terminal states
- ✅ **Adaptive chunk batching** - immediate forwarding for interactive use, auto-batch for burst generation
- ✅ **Graceful shutdown** - drain active requests, notify clients, close with 1001
- ✅ **Native WebSocket ping/pong** (not application-layer)
- ✅ Reuses existing `ModelRouter` and adapters
- ✅ Provides clear value for real-time use cases
- ✅ Remains completely optional (HTTP primary)

---

## References

- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [OpenAI Realtime API Guide](https://developers.openai.com/api/docs/guides/realtime/)
- [OpenAI Realtime Models & Prompting](https://developers.openai.com/api/docs/guides/realtime-models-prompting/)
- [WebSocket Protocol RFC 6455](https://tools.ietf.org/html/rfc6455)
