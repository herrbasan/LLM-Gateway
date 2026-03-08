# LLM Gateway API Documentation v2.0

Complete API reference for the LLM Gateway v2.0 (model-centric, stateless architecture).

---

## Table of Contents

1. [API Design Philosophy](#api-design-philosophy)
2. [Response Patterns](#response-patterns)
3. [Endpoints Reference](#endpoints-reference)
4. [Ticket-Based API](#ticket-based-api)
5. [Usage Patterns](#usage-patterns)
6. [Error Handling](#error-handling)

---

## API Design Philosophy

### Stateless Architecture

The gateway is **stateless**. Clients send full message history with each request. There is no session management, no `X-Session-Id` header, and no server-side conversation state.

### Unified Response Model

All chat requests go to one endpoint. By default, all responses are OpenAI-compatible `200 OK` — compaction is transparent. The `202` ticket flow is opt-in only.

| Prompt Size | Default Response | With `X-Async: true` |
|-------------|-----------------|----------------------|
| Fits in context | `200 OK` — immediate response | `200 OK` — immediate response |
| Exceeds context (≥`minTokensToCompact` AND > available tokens) | `200 OK` — server blocks, compacts transparently, then responds | `202 Accepted` — ticket created, progress via SSE |

> **Note:** `minTokensToCompact` (default: 2000) is the minimum threshold for running the compaction algorithm, not the sole trigger. Both conditions must be met: token count ≥ threshold AND tokens exceed available context window.

### Unified Streaming

All streaming uses a single SSE connection:

```bash
POST /v1/chat/completions
{ "stream": true, "messages": [...] }

# Small prompt: tokens stream immediately
data: {"choices":[{"delta":{"content":"Hello"}}]}

# Large prompt (default): compaction progress events, then tokens
event: compaction.progress
data: {"chunk":1,"total":3}

data: {"choices":[{"delta":{"content":"The"}}]}

# Large prompt (X-Async: true): returns 202 + ticket, client reconnects to stream
```

> **Backpressure:** If the client reads slowly, SSE events buffer in memory. For long compaction jobs, the server emits periodic heartbeat comments (`: heartbeat`) to detect stale connections, and caps the internal event buffer to prevent memory exhaustion.

---

## Response Patterns

The LLM Gateway handles three distinct response patterns based on prompt size and headers:

### Pattern 1: Small Prompt → Immediate 200

For prompts that fit within the context window:

```bash
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "Hello!"}]
}
```

**Response:**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1739999999,
  "model": "gemini-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello! How can I help you today?" }
  }]
}
```

### Pattern 2: Large Prompt → Transparent Compaction (200)

For oversized prompts, the gateway compacts automatically and returns 200:

```bash
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "...(45k tokens)..."}]
}
```

**Response:** Standard OpenAI format (compaction happens transparently on the server).

### Pattern 3: Large Prompt with Async (202 + Ticket)

For non-blocking large prompt processing:

```bash
POST /v1/chat/completions
Content-Type: application/json
X-Async: true

{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "...(45k tokens)..."}]
}
```

**Response:**
```json
{
  "object": "chat.completion.task",
  "ticket": "tkt_xyz789",
  "status": "accepted",
  "estimated_chunks": 3,
  "stream_url": "/v1/tasks/tkt_xyz789/stream"
}
```

---

## Endpoints Reference

### POST /v1/chat/completions

Main chat completion endpoint. Supports both streaming and non-streaming responses.

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |
| `X-Async` | `true` to get 202 + ticket for large prompts | No |
| `Accept` | `text/event-stream` for streaming | No |

**Request Body:**

```json
{
  "model": "gemini-flash",
  "messages": [
    {"role": "system", "content": "You are helpful"},
    {"role": "user", "content": "Explain quantum computing"}
  ],
  "max_tokens": 1000,
  "temperature": 0.7,
  "stream": false,
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "response", "strict": true, "schema": {...} }
  }
}
```

**Response 200 (Small Prompt):**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1739999999,
  "model": "gemini-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." }
  }]
}
```

**Response 202 (Large Prompt with `X-Async: true`):**

```json
{
  "object": "chat.completion.task",
  "ticket": "tkt_xyz789",
  "status": "accepted",
  "estimated_chunks": 3,
  "stream_url": "/v1/tasks/tkt_xyz789/stream"
}
```

---

### POST /v1/chat/completions (Streaming)

#### Small Prompt Streaming

```bash
curl http://localhost:3400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model": "gemini-flash", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

**Response:**
```
data: {"id":"...","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"...","choices":[{"delta":{"content":" world"}}]}
data: [DONE]
```

#### Large Prompt Streaming (Transparent Compaction)

```bash
curl http://localhost:3400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model": "gemini-flash", "messages": [{"role": "user", "content": "...(45k tokens)"}], "stream": true}'
```

**Response:**
```
event: compaction.start
data: {"estimated_chunks":3}

event: compaction.progress
data: {"chunk":1,"total":3}

event: compaction.complete
data: {"original_tokens":45000,"final_tokens":2800}

data: {"id":"...","choices":[{"delta":{"content":"The"}}]}
data: {"id":"...","choices":[{"delta":{"content":" answer"}}]}
data: [DONE]
```

> Compaction progress events are non-standard SSE events (prefixed with `compaction.`). Standard OpenAI SDKs will ignore them, receiving only the `data:` token chunks. Clients that understand compaction events get progress visibility for free.

**Streaming Error Handling:**
```
event: error
data: {"ticket":"tkt_xxx","error":{"type":"provider_error","message":"Connection lost"}}
```

On error: connection closes, partial content discarded, client can retry.

---

### POST /v1/embeddings

Generate embeddings for text input.

```json
{
  "input": ["text to embed", "second text"],
  "model": "gemini-embedding"
}
```

**Response:**
```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "embedding": [0.0023, ...], "index": 0 }
  ],
  "model": "gemini-embedding",
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

---

### GET /v1/models

List available models from config. Supports filtering by type.

```bash
GET /v1/models
GET /v1/models?type=chat
GET /v1/models?type=image
GET /v1/models?type=audio
GET /v1/models?type=video
GET /v1/models?type=embedding
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "gemini-flash",
      "object": "model",
      "owned_by": "gemini",
      "type": "chat",
      "capabilities": {
        "contextWindow": 1048576,
        "vision": true,
        "streaming": true
      }
    }
  ]
}
```

---

### POST /v1/images/generations

OpenAI-compatible image generation endpoint.

- Behavior is intentionally asynchronous in the gateway.
- Returns `202 Accepted` with a ticket so long-running image jobs do not block HTTP connections.

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |

**Request Body:**

```json
{
  "model": "dall-e-3",
  "prompt": "A cinematic cyberpunk street at night",
  "size": "1024x1024",
  "quality": "high",
  "n": 1,
  "response_format": "b64_json"
}
```

**Response 202:**

```json
{
  "object": "media.generation.task",
  "ticket": "tkt_abc123def456",
  "status": "accepted",
  "estimated_chunks": 1,
  "stream_url": "/v1/tasks/tkt_abc123def456/stream"
}
```

When completed, polling `/v1/tasks/:id` returns `result.data[]`. If `b64_json` is present and media staging is enabled, the gateway also includes `local_url` pointing to `/v1/media/<file>`.

---

### POST /v1/audio/speech

OpenAI-compatible text-to-speech endpoint.

- Behavior is synchronous by default.
- Returns binary audio directly (`audio/mpeg`, `audio/wav`, etc.).

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |

**Request Body:**

```json
{
  "model": "tts-model",
  "input": "Welcome to the LLM Gateway",
  "voice": "alloy",
  "response_format": "mp3",
  "speed": 1.0
}
```

**Response 200:**

- Binary audio body
- `Content-Type: audio/<format>`

---

### POST /v1/videos/generations

OpenAI-compatible video generation endpoint.

- Behavior is intentionally asynchronous in the gateway.
- Returns `202 Accepted` with a ticket so long-running video jobs do not block HTTP connections.

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |

**Request Body:**

```json
{
  "model": "video-model",
  "prompt": "A serene landscape with mountains and flowing rivers",
  "duration": 5,
  "resolution": "720p",
  "quality": "high"
}
```

**Response 202:**

```json
{
  "object": "media.generation.task",
  "ticket": "tkt_vid123abc",
  "status": "accepted",
  "estimated_chunks": 1,
  "stream_url": "/v1/tasks/tkt_vid123abc/stream"
}
```

---

### GET /v1/media/:filename

Serves staged media files (for generated outputs or future file workflows).

- Enabled only when `mediaStorage.enabled=true`.
- Files are temporary and evicted by TTL policy.

```bash
GET /v1/media/media_1741068842000_a1b2c3d4.png
```

---

### GET /health

Health check endpoint with adapter status.

```bash
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "version": "2.0.0",
  "adapters": {
    "gemini": { "state": "CLOSED" },
    "openai": { "state": "CLOSED" }
  },
  "models": ["gemini-flash", "local-llama", ...]
}
```

---

### GET /help

Returns this API documentation rendered as HTML.

```bash
GET /help
```

---

## Ticket-Based API

Used for:

- Large chat prompts when `X-Async: true` is set
- Image generation jobs (`/v1/images/generations`, always async)

Without `X-Async`, chat compaction is transparent and no chat ticket is created.

### Query Task Status

```bash
GET /v1/tasks/tkt_xyz789
```

**Response:**
```json
{
  "object": "chat.completion.task",
  "ticket": "tkt_xyz789",
  "status": "complete",
  "estimated_chunks": 1,
  "stream_url": "/v1/tasks/tkt_xyz789/stream",
  "result": {
    "content": "The answer is...",
    "usage": {...}
  }
}
```

Notes:

- On first poll, the gateway logs `async_ticket_age_before_poll=<ms>` for observability.
- For failed tickets, response includes `error`.
- For media generation tickets, `result` is the provider payload (and may include `local_url` entries for staged assets).

### Stream Task Progress

```bash
GET /v1/tasks/tkt_xyz789/stream
Headers: Accept: text/event-stream
```

Task stream emits SSE events, including:

- `chunk` / completion chunks for chat streams
- `status_update` transitions (`processing`, `complete`, `failed`)
- terminal `[DONE]`

---

## Usage Patterns

### Model Resolution

| Use Case | Request | Resolution |
|----------|---------|------------|
| Default model | Omit `model` or use configured default | Uses `routing.defaultChatModel` from config |
| Specific model | `"model": "gemini-flash"` | Looks up model by ID in config |
| List models | `GET /v1/models` | Returns flat list from config |

### Chat Completions

| Use Case | Implementation |
|----------|---------------|
| Small prompt | `200 OK` — immediate response |
| Large prompt (default) | `200 OK` — server compacts transparently, then responds |
| Large prompt (async) | `202 Accepted` — requires `X-Async: true` header |
| Streaming | Unified SSE (small=tokens, large=progress+tokens) |
| Structured output | `response_format: { type: "json_schema" }` — routed only to models with `structuredOutput` capability |
| Token constraints | `max_tokens` respected by all adapters |

### Media Generation

| Use Case | Implementation |
|----------|---------------|
| Text-to-image | `POST /v1/images/generations` always returns `202 + ticket` |
| Text-to-speech | `POST /v1/audio/speech` returns synchronous binary audio |
| Provider mismatch | Router enforces capability flags (type must match) |
| Temporary assets | Staged under `/v1/media/*` when enabled |
| Asset cleanup | TTL-based eviction |

---

## Error Handling

| Code | Meaning |
|------|---------|
| 200 | Success (small prompt or transparent compaction complete) |
| 202 | Accepted (large prompt, async ticket created) |
| 400 | Bad request (wrong model type, missing fields) |
| 404 | Model not found |
| 413 | Payload too large (even after compaction) |
| 429 | Rate limit or queue full |
| 502 | Provider unavailable |
| 504 | Timeout |

---

## Configuration

### Model Definition

```json
{
  "models": {
    "model-id": {
      "type": "chat",
      "adapter": "gemini",
      "endpoint": "https://...",
      "apiKey": "${ENV_VAR}",
      "adapterModel": "provider-model-name",
      "capabilities": {
        "contextWindow": 1048576,
        "vision": true,
        "structuredOutput": "json_schema",
        "streaming": true
      }
    }
  }
}
```

### Model Types

- `chat` - Chat completion models
- `embedding` - Text embedding models
- `image` - Image generation models
- `audio` - Audio/speech generation models
- `video` - Video generation models

### Capability Fields

**Chat Models:**
- `contextWindow` (number) - Maximum context window in tokens
- `vision` (boolean) - Supports image inputs
- `structuredOutput` (boolean | string) - Supports JSON output
- `streaming` (boolean) - Supports streaming responses

**Embedding Models:**
- `contextWindow` (number) - Maximum input tokens
- `dimensions` (number) - Output embedding dimensions

**Image Models:**
- `maxResolution` (string) - Maximum image resolution
- `supportedFormats` (array) - Supported output formats

**Audio Models:**
- `maxDuration` (number) - Maximum audio duration in seconds
- `supportedFormats` (array) - Supported output formats

**Video Models:**
- `maxDuration` (number) - Maximum video duration in seconds
- `maxResolution` (string) - Maximum video resolution (e.g., "1080p")

---

## Migration from v1.x

### Removed Features

- **Sessions** - No `X-Session-Id` header, no session endpoints
- **Provider-centric routing** - Models are referenced by ID, not `provider:model`
- **Capability inference** - All capabilities explicitly declared

### Config Changes

**v1.x:**
```json
{
  "providers": {
    "gemini": {
      "type": "gemini",
      "model": "gemini-flash"
    }
  }
}
```

**v2.0:**
```json
{
  "models": {
    "gemini-flash": {
      "type": "chat",
      "adapter": "gemini",
      "capabilities": {...}
    }
  }
}
```

### Client Changes

**v1.x:**
```javascript
// Create session, then use X-Session-Id
const session = await fetch('/v1/sessions', {method: 'POST'});
await fetch('/v1/chat/completions', {
  headers: {'X-Session-Id': session.id}
});
```

**v2.0:**
```javascript
// Send full history each time
await fetch('/v1/chat/completions', {
  body: JSON.stringify({
    model: 'gemini-flash',
    messages: fullHistory
  })
});
```
