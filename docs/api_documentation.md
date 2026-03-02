# LLM Gateway API Documentation

Complete API reference and usage patterns for the LLM Gateway.

---

## Table of Contents

1. [API Design Philosophy](#api-design-philosophy)
2. [Response Patterns](#response-patterns)
3. [Endpoints Reference](#endpoints-reference)
4. [Usage Patterns](#usage-patterns)
5. [Headers](#headers)
6. [Error Handling](#error-handling)

---

## API Design Philosophy

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
  "model": "auto",
  "messages": [{"role": "user", "content": "Hello!"}]
}
```

**Response:**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1739999999,
  "model": "qwen2.5-14b",
  "provider": "lmstudio",
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
  "model": "auto",
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
  "model": "auto",
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
| `X-Provider` | Override provider: `lmstudio`, `ollama`, `gemini` | No |
| `X-Session-Id` | Continue existing session | No |
| `X-Async` | `true` to get 202 + ticket for large prompts | No |
| `Accept` | `text/event-stream` for streaming | No |

**Request Body:**

```json
{
  "model": "auto",
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
  "model": "qwen2.5-14b",
  "provider": "lmstudio",
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
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
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
  -d '{"model": "auto", "messages": [{"role": "user", "content": "...(45k tokens)"}], "stream": true}'
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
  "model": "nomic-embed-text"
}
```

**Response:**
```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "embedding": [0.0023, ...], "index": 0 }
  ],
  "model": "nomic-embed-text",
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

---

### GET /v1/models

List available models from all configured providers.

```bash
GET /v1/models
GET /v1/models?type=embeddings
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen2.5-14b",
      "object": "model",
      "owned_by": "lmstudio",
      "capabilities": {
        "embeddings": false,
        "structured_output": true,
        "context_window": 32768
      }
    }
  ]
}
```

---

### GET /health

Health check endpoint with provider status.

```bash
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "providers": {
    "lmstudio": {
      "status": "healthy",
      "model": "qwen2.5-14b",
      "queue_depth": 0,
      "active_requests": 1
    }
  }
}
```

---

### POST /v1/sessions

Create a new conversation session.

```bash
POST /v1/sessions
```

**Response:**
```json
{ "session_id": "sess_abc123", "created_at": "2026-02-28T19:00:00Z" }
```

---

## Ticket-Based API

For large prompts when `X-Async: true` is set. Without this header, compaction is transparent and no tickets are created.

### Query Task Status

```bash
GET /v1/tasks/tkt_xyz789
```

**Response:**
```json
{
  "ticket": "tkt_xyz789",
  "state": "complete",
  "result": {
    "content": "The answer is...",
    "usage": {...}
  }
}
```

### Stream Task Progress

```bash
GET /v1/tasks/tkt_xyz789/stream
Headers: Accept: text/event-stream
```

---

## Usage Patterns

### Model Resolution

| Use Case | Request | Resolution |
|----------|---------|------------|
| Default model | Omit `model` or use `"auto"` | Adapter's `resolveModel()` finds loaded model or uses config default |
| List models | `GET /v1/models` | Aggregates from all adapters with `capabilities` filter |
| Specific model | `"model": "qwen2.5-14b"` | Searches all adapters, requires `X-Provider` if ambiguous |
| Namespaced model | `"model": "lmstudio:qwen2.5-14b"` | Routes to specific adapter |

### Chat Completions

| Use Case | Implementation |
|----------|---------------|
| Small prompt | `200 OK` — immediate response |
| Large prompt (default) | `200 OK` — server compacts transparently, then responds |
| Large prompt (async) | `202 Accepted` — requires `X-Async: true` header |
| Streaming | Unified SSE (small=tokens, large=progress+tokens) |
| With/without system prompt | Standard messages array |
| Structured output | `response_format: { type: "json_schema" }` — routed only to providers with `structuredOutput` capability |
| Token constraints | `max_tokens` respected by all adapters |

### Sessions

| Use Case | Implementation |
|----------|---------------|
| Create session | `POST /v1/sessions` → returns `session_id` |
| Follow-up question | Include `X-Session-Id: sess_xxx` header |
| Context management | Auto-compaction of older messages (preserve-last-N) |
| TTL | Sessions expire 1 hour after last interaction |
| Persistence | **In-memory only** - lost on server restart |

### Session Context Management

```
Given:
- contextWindow: Provider's max context
- outputBuffer: max_tokens or default
- preserveLastN: Recent message pairs to keep (default: 4)
- systemPrompt: Always preserved

Algorithm:
1. Load session messages from memory
2. If total tokens < available: Send full conversation
3. Else:
   a. Preserve: System prompt + last N exchanges
   b. If preserved content alone exceeds available tokens:
      - Dynamically reduce N until it fits, minimum N=1
      - If N=1 still exceeds: truncate the oldest message in the preserved set
      - If system prompt alone exceeds: return 413 Payload Too Large
   c. Compact: Older messages into rolling summary
   d. Final: [System] + [Summary] + [Recent N]
4. If compaction fails mid-session:
   - Fall back to truncation (drop oldest, keep recent N)
   - Log the failure, do not block the request
5. On successful compaction: replace older messages with summary in session store
```

---

## Headers

| Header | Format | Description |
|--------|--------|-------------|
| `X-Provider` | `lmstudio`, `ollama`, `gemini`, etc. | Override the default provider for this request |
| `X-Session-Id` | `sess_xxx` | Continue an existing conversation session |
| `X-Async` | `true` or `false` | Enable async ticket-based processing for large prompts |

---

## Error Handling

| Code | Meaning |
|------|---------|
| 200 | Success (small prompt or transparent compaction complete) |
| 202 | Accepted (large prompt, async ticket created) |
| 400 | Bad request |
| 404 | Provider/model/session/ticket not found |
| 413 | Payload too large (even after compaction) |
| 429 | Rate limit or queue full |
| 502 | Provider unavailable |
| 504 | Timeout |

---

## Conventions

### Field Naming

- **API payloads (request/response JSON):** snake_case (`context_window`, `max_tokens`, `session_id`)
- **HTTP headers:** X-Prefixed-Kebab-Case (`X-Session-Id`, `X-Provider`, `X-Async`)

Translation happens at the API boundary layer (route handlers).
