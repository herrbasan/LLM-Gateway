# LLM Gateway WebSocket API Documentation

## WebSocket Real-Time API

The WebSocket real-time mode provides a high-performance, bi-directional channel using JSON-RPC 2.0. It is designed for low-latency conversational agents and applications that need stream multiplexing, message interruption (cancellation), binary media uploads, and binary audio streaming.

**Endpoint:**
```
ws://localhost:3400/v1/realtime
```
> **Security:** By default, WebSocket access is restricted to local/internal IP addresses only (`WS_LOCAL_ONLY=true`). Local connections (`127.0.0.1`, `::1`) are auto-authenticated.
>
> You can whitelist trusted IP ranges in `config.json` via:
> `"ws": { "whitelistIps": ["192.168.0.*", "10.0.*"] }`
> Any connections coming from these IPs bypass the global `accessKey` requirements entirely, allowing frictionless private network use.

### Authentication
Authentication can be done via HTTP upgrade headers (preferred) or via the first `session.initialize` message.

> **Important Security Note:** The `GATEWAY_ACCESS_KEY` mentioned below is a **Gateway Access Key** (used to secure access to the Gateway itself when `WS_LOCAL_ONLY` is disabled). It is **not** an OpenAI, Gemini, or provider API key. You should never expose your actual provider keys to clients. The Gateway securely stores the provider keys internal to its configuration and auto-injects them into upstream requests.

**Via Upgrade Header:**
```javascript
const ws = new WebSocket('ws://localhost:3400/v1/realtime', {
  headers: { 'Authorization': 'Bearer GATEWAY_ACCESS_KEY' }
});
```

**Via session.initialize (if upgrade headers are impossible):**
```json
{
  "jsonrpc": "2.0",
  "id": "auth-1",
  "method": "session.initialize",
  "params": {
    "access_key": "GATEWAY_ACCESS_KEY"
  }
}
```

### JSON-RPC Commands

#### `chat.create`
Initiates a new chat completion stream.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "chat.create",
  "params": {
    "model": "gemini-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "strip_thinking": true
  }
}
```

**With Task:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "chat.create",
  "params": {
    "task": "query",
    "messages": [{"role": "user", "content": "Hello"}],
    "temperature": 0.9
  }
}
```

When `task` is provided, the gateway resolves the task's default model and parameters. Client-supplied params (like `temperature`, `model`, `max_tokens`) override task defaults. If the task defines a `systemPrompt`, it is prepended as the first system message.

> **Thinking Stripper:** When `strip_thinking: true` or `no_thinking: true` is included in the params, any output reasoning tokens (like DeepSeek `<think` tags or native `reasoning_content`) are automatically stripped from the `chat.delta` stream, yielding only the final cleanly-formatted answer.

> **Thinking Control:** Use `enable_thinking: false` in params to disable verbose model reasoning at the source. This prevents the model from producing thinking tokens entirely (more efficient than stripping after the fact). See the REST API docs for adapter support matrix.

**Responses:** Server streams multiple `chat.delta` notifications, followed by `chat.done`.

```json
// Server -> Client
{"jsonrpc": "2.0", "method": "chat.progress", "params": {"request_id": "req-1", "phase": "routing", "task": "query"}}
{"jsonrpc": "2.0", "method": "chat.progress", "params": {"request_id": "req-1", "phase": "model_routed", "model": "gemini-flash", "provider": "gemini"}}
{"jsonrpc": "2.0", "method": "chat.progress", "params": {"request_id": "req-1", "phase": "context"}}
{"jsonrpc": "2.0", "method": "chat.progress", "params": {"request_id": "req-1", "phase": "context_stats", "context": {"window_size": 1048576, "used_tokens": 2800, "available_tokens": 1045776, "strategy_applied": false, "resolved_max_tokens": 835060, "max_tokens_source": "implicit"}}}
{"jsonrpc": "2.0", "method": "chat.delta", "params": {"request_id": "req-1", "choices": [{"index": 0, "delta": {"content": "Hello! "}}]}}
{"jsonrpc": "2.0", "method": "chat.done", "params": {"request_id": "req-1", "cancelled": false, "finish_reason": "stop", "model": "gemini-flash", "provider": "gemini", "context": {...}, "telemetry": {"time_to_first_token_ms": 120, "total_duration_ms": 340, "chunks_sent": 5, "usage": {"prompt_tokens": 2800, "completion_tokens": 42, "total_tokens": 2842}, "reasoning_produced": false}}}
```

If `max_tokens` is omitted from `params`, the gateway resolves a safe output budget automatically and reports it in the `chat.progress` `context_stats` payload.

#### `chat.append`
Efficient incremental context update using a connection-scoped buffer. Appends only the new message to avoid sending massive context histories repeatedly.

```json
{
  "jsonrpc": "2.0",
  "id": "req-2",
  "method": "chat.append",
  "params": {
    "model": "gemini-flash",
    "message": {"role": "user", "content": "What's next?"}
  }
}
```

**With Task:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-2",
  "method": "chat.append",
  "params": {
    "task": "query",
    "message": {"role": "user", "content": "What's next?"}
  }
}
```

#### `chat.cancel`
Cancels an ongoing generation stream.

```json
{
  "jsonrpc": "2.0",
  "id": "cancel-1",
  "method": "chat.cancel",
  "params": {"request_id": "req-1"}
```

The cancellation target is the original `chat.create` or `chat.append` request ID. On success, the server stops streaming, aborts the upstream provider request, and finishes with:

```json
{"jsonrpc": "2.0", "method": "chat.done", "params": {"request_id": "req-1", "cancelled": true, "finish_reason": "cancel", "telemetry": {"total_duration_ms": 1234, "chunks_sent": 3, "usage": null}}}
```

There is no separate acknowledgement response for `chat.cancel`; `chat.done` with `cancelled: true` is the completion signal.

#### `settings.update`
Acknowledge a settings change from the client. Used by clients to notify the gateway of configuration updates (e.g., model preferences, temperature changes).

```json
{
  "jsonrpc": "2.0",
  "id": "settings-1",
  "method": "settings.update",
  "params": {
    "temperature": 0.7,
    "max_tokens": 4096
  }
}
```

### Stream Notifications

During an active request, the server can emit these JSON-RPC notifications:

- `chat.progress`: lifecycle and context updates such as `routing`, `model_routed`, `context`, `context_stats`, `network_throttled`, and `reasoning_started`
- `chat.delta`: streamed token chunks in OpenAI-compatible `choices[].delta` shape
- `chat.done`: terminal event with `cancelled`, `finish_reason`, `model`, `provider`, `context`, and `telemetry` (including `usage`, `chunks_sent`, `reasoning_produced`, timing)
- `chat.error`: terminal error event

Example `context_stats` notification:

```json
{
  "jsonrpc": "2.0",
  "method": "chat.progress",
  "params": {
    "request_id": "req-1",
    "phase": "context_stats",
    "context": {
      "window_size": 1048576,
      "used_tokens": 2800,
      "available_tokens": 1045776,
      "strategy_applied": false,
      "resolved_max_tokens": 835060,
      "max_tokens_source": "implicit"
    }
  }
}
```

### Tool Use / Function Calling

The WebSocket endpoint supports OpenAI-spec tool use (function calling). Tools are specified in `chat.create` or `chat.append` params, and tool call results are aggregated and returned in `chat.done`.

**Request with tools:**

```json
{
  "jsonrpc": "2.0",
  "id": "tool-req-1",
  "method": "chat.create",
  "params": {
    "model": "gemini-flash",
    "messages": [{"role": "user", "content": "Read the file config.json"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "description": "Read file contents",
          "parameters": {
            "type": "object",
            "properties": {
              "path": { "type": "string", "description": "File path to read" }
            },
            "required": ["path"]
          }
        }
      }
    ],
    "tool_choice": "auto"
  }
}
```

**Streaming tool call deltas** arrive in `chat.delta` notifications following the OpenAI format:

```json
{"jsonrpc":"2.0","method":"chat.delta","params":{"request_id":"tool-req-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}}
{"jsonrpc":"2.0","method":"chat.delta","params":{"request_id":"tool-req-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":\"config.json\"}"}}]},"finish_reason":"tool_calls"}]}}
```

**`chat.done` includes aggregated tool calls:**

```json
{
  "jsonrpc": "2.0",
  "method": "chat.done",
  "params": {
    "request_id": "tool-req-1",
    "cancelled": false,
    "finish_reason": "tool_calls",
    "content": null,
    "tool_calls": [
      {
        "id": "call_abc",
        "type": "function",
        "function": {
          "name": "read_file",
          "arguments": "{\"path\":\"config.json\"}"
        }
      }
    ],
    "model": "gemini-flash",
    "provider": "gemini",
    "context": {...},
    "telemetry": {...}
  }
}
```

**Returning tool results** via `chat.append`:

```json
{
  "jsonrpc": "2.0",
  "id": "tool-result-1",
  "method": "chat.append",
  "params": {
    "model": "gemini-flash",
    "message": {"role": "tool", "tool_call_id": "call_abc", "content": "{\"apiKey\": \"...\", ...}"}
  }
}
```

The gateway automatically preserves the assistant's `tool_calls` in the internal conversation buffer, so subsequent `chat.append` turns send complete multi-turn history to the model.

**Fields added to `chat.done`:**

| Field | Type | Description |
|-------|------|-------------|
| `content` | string/null | Aggregated text content from the response |
| `tool_calls` | array/null | Aggregated tool calls (null when no tools called) |

These fields are additive — existing `chat.done` fields (`request_id`, `cancelled`, `finish_reason`, `model`, `provider`, `context`, `telemetry`) remain unchanged.

---

### Binary Media Upload Protocol

Upload files (images, documents) via a binary frame protocol without Base64 overhead. Uploaded files are stored locally and injected into chat messages using the `gateway-media://` URL scheme.

#### `media.start`
Initiates a binary media upload stream.

```json
{
  "jsonrpc": "2.0",
  "id": "media-open",
  "method": "media.start",
  "params": {
    "filename": "photo.jpg",
    "mimeType": "image/jpeg",
    "size": 1048576
  }
}
```

**Server Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "media-open",
  "result": {
    "stream_id": "media_abc123",
    "gateway_url": "gateway-media://media_abc123/photo.jpg"
  }
}
```

**Sending Binary Frames:**
Combine a JSON header (null-byte terminated) with raw binary payload:
```
{"s":"media_abc123", "t": 1705312200000, "seq": 1}\x00[RAW BINARY DATA]
```

The server emits `media.progress` notifications approximately every 1MB of uploaded data.

#### `media.stop`
Completes the media upload stream.

```json
{
  "jsonrpc": "2.0",
  "id": "media-close",
  "method": "media.stop",
  "params": {"stream_id": "media_abc123"}
}
```

**Using uploaded media in chat:**
After upload, use the `gateway-media://` URL in message content:

```json
{
  "jsonrpc": "2.0",
  "id": "img-req-1",
  "method": "chat.create",
  "params": {
    "model": "gemini-flash",
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "What is in this image?" },
        { "type": "image_url", "image_url": { "url": "gateway-media://media_abc123/photo.jpg" } }
      ]
    }]
  }
}
```

---

### Binary Audio Protocol

For high-performance audio transmission without Base64 overhead, use the header-prefixed binary frames.

#### `audio.start`
Negotiates format and opens an audio stream.

```json
{
  "jsonrpc": "2.0",
  "id": "audio-open",
  "method": "audio.start"
}
```

*Server replies with a format map including `stream_id` and the negotiated format (e.g., PCM16 for local connections, Opus for remote).*

**Sending Binary Frames:**
Combine a JSON header (null-byte terminated) with a raw audio payload:
```
{"s":"stream_id", "t": 1705312200000, "seq": 1}\x00[RAW BINARY DATA]
```

#### `audio.stop`
Closes the audio stream.

```json
{
  "jsonrpc": "2.0",
  "id": "audio-close",
  "method": "audio.stop",
  "params": {"stream_id": "stream_id"}
}
```

#### `audio.vad`
Voice Activity Detection event. Used to signal speech start/stop boundaries from the client to the server.

```json
{
  "jsonrpc": "2.0",
  "id": "vad-1",
  "method": "audio.vad",
  "params": {
    "event": "speech_start",
    "stream_id": "stream_id"
  }
}
```

> **Note:** The audio protocol is a framework in place — `audio.start/stop/vad` handle stream negotiation and binary frame routing, but audio data is not currently forwarded to a backend model for processing.

---

### Sending Images & Files (Inline)

To send images or files without the binary upload protocol, include them as standard OpenAI-compatible base64 payloads or remote URLs directly in JSON-RPC `chat.create` or `chat.append` requests.

**Example Base64 Image:**
```json
{
  "jsonrpc": "2.0",
  "id": "img-req-1",
  "method": "chat.create",
  "params": {
    "model": "gemini-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "What is in this image?" },
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."
            }
          }
        ]
      }
    ]
  }
}
```

*Note: Due to JSON serialization overhead, very large base64 image strings may impact WebSocket responsiveness briefly. For large files, prefer the binary media upload protocol.*

---

### `ping`

Connection keep-alive and latency measurement.

```json
{
  "jsonrpc": "2.0",
  "id": "ping-1",
  "method": "ping"
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "ping-1",
  "result": { "pong": 1705312200000 }
}
```
