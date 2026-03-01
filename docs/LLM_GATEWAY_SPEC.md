# LLM Gateway

Centralized LLM service with transparent context-window management and multi-provider routing.

**Core Idea:** OpenAI-compatible API that handles oversized prompts automatically. All requests return standard OpenAI-compatible responses (200 OK) by default — oversized prompts are transparently compacted before completion. Opt-in async mode (`X-Async: true`) returns 202 Accepted with ticket-based progress tracking.

---

## Features

- **OpenAI-Compatible HTTP API** - Works with existing SDKs (standard 200 responses by default)
- **Transparent Compaction** - Automatic for oversized prompts (blocks and returns 200; opt-in 202 + ticket via `X-Async: true`)
- **Unified Streaming** - Single SSE mechanism for all streaming (compaction progress events + token streaming)
- **Multi-Provider Routing** - LM Studio, Ollama, Gemini with adapter:model resolution
- **Structured Output Guard** - Routes `response_format` requests only to providers with `structuredOutput` capability
- **Session Support** - Multi-turn conversations with in-memory context (1h TTL)
- **Minimal Dependencies** - Express + vanilla JavaScript, no build step

---

## Quick Start

```bash
npm install
# Copy and edit config
cp config.example.json config.json
npm start
# Service runs on http://localhost:3400
```

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

## Use Cases

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

---

## Simple HTTP Endpoints

### POST /v1/chat/completions

**Headers:**
| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `X-Provider` | (Optional) Override provider: `lmstudio`, `ollama`, `gemini` |
| `X-Session-Id` | (Optional) Continue existing session |
| `X-Async` | (Optional) `true` to get 202 + ticket for large prompts instead of blocking |
| `Accept` | `text/event-stream` for streaming |

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

**Response 202 (Large Prompt — only with `X-Async: true`):**
```json
{
  "object": "chat.completion.task",
  "ticket": "tkt_xyz789",
  "status": "accepted",
  "estimated_chunks": 3,
  "stream_url": "/v1/tasks/tkt_xyz789/stream"
}
```

> Without `X-Async: true`, large prompts are compacted transparently and return a standard `200 OK` response. This preserves full OpenAI SDK compatibility.

### POST /v1/chat/completions (Streaming)

**Small Prompt Streaming:**
```bash
curl http://localhost:3400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

```
data: {"id":"...","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"...","choices":[{"delta":{"content":" world"}}]}
data: [DONE]
```

**Large Prompt Streaming (default — transparent compaction):**
```bash
curl http://localhost:3400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "...(45k tokens)"}], "stream": true}'
```

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

### POST /v1/embeddings

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

### GET /v1/models

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

### GET /health

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

## Session Management

Sessions persist conversation context in memory.

### Create Session

```bash
POST /v1/sessions
```

**Response:**
```json
{ "session_id": "sess_abc123", "created_at": "2026-02-28T19:00:00Z" }
```

### Use Session

```bash
POST /v1/chat/completions
Header: X-Session-Id: sess_abc123
```

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

**Session TTL:** 1 hour after last interaction (memory cleanup).

**Note:** Sessions are lost on server restart.

---

## Configuration

`config.json`:

```json
{
  "port": 3400,
  "host": "0.0.0.0",
  
  "compaction": {
    "enabled": true,
    "minTokensToCompact": 2000,
    "preserveSystemPrompt": true,
    "targetRatio": 0.3,
    "chunkSize": 3000,
    "maxPasses": 3,
    "timeoutMs": 60000,
    "preserveLastN": 4,
    "heartbeatIntervalMs": 15000
  },
  
  "tokenEstimation": {
    "strategy": "auto",
    "fallbackRatio": 0.25
  },
  
  "routing": {
    "defaultProvider": "lmstudio",
    "embeddingProvider": "lmstudio"
  },
  
  "concurrency": {
    "defaultMaxConcurrent": 2,
    "defaultQueueDepth": 10
  },
  
  "sessions": {
    "ttlMinutes": 60
  },
  
  "providers": {
    "lmstudio": {
      "type": "lmstudio",
      "endpoint": "http://localhost:1234",
      "model": "qwen2.5-14b",
      "embeddingModel": "nomic-embed-text-v2-moe",
      "contextWindow": 32768,
      "maxConcurrentCalls": 2,
      "stripThinking": true,
      "capabilities": {
        "embeddings": true,
        "structuredOutput": true,
        "streaming": true
      },
      "retry": {
        "enabled": true,
        "maxAttempts": 3,
        "backoffMs": 1000,
        "retryOn": [502, 504, "ETIMEDOUT", "ECONNREFUSED"]
      }
    },
    "ollama": {
      "type": "ollama",
      "endpoint": "http://localhost:11434",
      "model": "llama3.2",
      "maxConcurrentCalls": 2,
      "capabilities": {
        "embeddings": true,
        "structuredOutput": false,
        "streaming": true
      }
    },
    "gemini": {
      "type": "gemini",
      "apiKey": "${GEMINI_API_KEY}",
      "model": "gemini-2.0-flash",
      "maxConcurrentCalls": 5,
      "capabilities": {
        "embeddings": true,
        "structuredOutput": true,
        "streaming": true
      }
    }
  }
}
```

---

## Provider Adapter Interface

```javascript
const createLmStudioAdapter = (config) => ({
  name: 'lmstudio',
  capabilities: {
    embeddings: true,
    structuredOutput: true,
    streaming: true
  },
  
  // Required
  async resolveModel() { ... },
  getModel() { ... },
  
  async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) { ... },
  
  async *streamComplete({ prompt, systemPrompt, maxTokens, temperature, schema }) {
    // Yield: { content: "token" }
    // Throw: new Error("...") for failures
  },
  
  async embedText(text, requestedModel) { ... },
  async embedBatch(texts, requestedModel) { ... },
  
  async listModels() { ... },
  async getContextWindow() { ... },
  
  // Optional
  async loadModel(modelName) { ... },
  async unloadModel(modelName) { ... }
});
```

---

## How Compaction Works

### Trigger

```javascript
const needsCompaction = estimateTokens(prompt) >= minTokensToCompact && 
                        estimateTokens(prompt) > (contextWindow - outputBuffer);

if (needsCompaction) {
  if (request.headers['x-async'] === 'true') {
    return 202; // Async ticket-based compaction
  }
  // Default: compact transparently, then return 200
  const compacted = await compact(prompt, contextWindow - outputBuffer);
  return complete(compacted); // 200 OK
}
```

> `minTokensToCompact` is the minimum threshold for running the algorithm — it prevents wasting compute on prompts that are only slightly over. Both conditions must be true.

### Algorithm

```
Original: 45,000 tokens

Step 1: CHUNK
┌──────────┬──────────┬──────────┐
│ 15k      │ 15k      │ 15k      │  ← 3 chunks
└──────────┴──────────┴──────────┘

Step 2: ROLLING COMPACT (broadcast progress)
Chunk 1 → Summary A (5k)
Chunk 2 + Summary A → Summary B (5k)
Chunk 3 + Summary B → Summary C (5k)

Step 3: FINAL
Summary C (5k) + System + Buffer = Fits in context
```

---

## Architecture

```
Express Server
  ↓
Routes (/v1/chat/completions, /v1/embeddings, /v1/models)
  ↓
Router (decide: direct vs compact vs async ticket)
  ↓
┌───────────────┬───────────────┬───────────────┐
↓               ↓               ↓               ↓
Direct         Transparent    Ticket         Session
Response       Compaction     Registry       Store
(200)          (200)          (202+Map)      (Map)
                              ↓
                              Compaction
                              Worker Pool
                              ↓
                              Provider Adapters
```

### File Structure

```
src/
├── main.js
├── config.js
├── routes/
│   ├── completions.js
│   ├── embeddings.js
│   ├── models.js
│   ├── sessions.js
│   └── health.js
├── core/
│   ├── router.js
│   ├── ticket.js
│   ├── retry.js
│   └── pool.js
├── compaction/
│   ├── chunk.js
│   ├── compact.js
│   └── roller.js
├── providers/
│   ├── lmstudio.js
│   ├── ollama.js
│   └── gemini.js
├── sessions/
│   └── store.js
└── utils/
    └── fn.js
```

---

## Error Handling

| Code | Meaning |
|------|---------|
| 200 | Success (small prompt) |
| 202 | Accepted (large prompt, compaction needed) |
| 400 | Bad request |
| 404 | Provider/model/session/ticket not found |
| 413 | Payload too large (even after compaction) |
| 429 | Rate limit or queue full |
| 502 | Provider unavailable |
| 504 | Timeout |

---

## MVP Phasing

### Phase 1: Core Chat
- [ ] Express server
- [ ] `POST /v1/chat/completions` returns 200 for small prompts
- [ ] Provider routing (reject `response_format` to providers without `structuredOutput`)
- [ ] `GET /health`
- [ ] `GET /v1/models`
- **AC**: Can curl chat completion

### Phase 2: Streaming
- [ ] Unified SSE streaming
- [ ] Adapter `streamComplete()` method
- [ ] Heartbeat comments (`: heartbeat`) for long-lived connections
- **AC**: `stream: true` works

### Phase 3: Tickets
- [ ] `X-Async: true` header enables 202 response for large prompts
- [ ] Ticket registry (Map)
- [ ] `GET /v1/tasks/:id`
- **AC**: Large prompt with `X-Async: true` returns 202

### Phase 4: Compaction
- [ ] Chunking
- [ ] Rolling compaction
- [ ] Progress events
- [ ] Transparent compaction (default: block and return 200)
- [ ] Tiered token estimation (provider API → tiktoken → heuristic)
- **AC**: 45k tokens → compacted → complete (200 OK)

### Phase 5: Sessions
- [ ] `POST /v1/sessions`
- [ ] Context accumulation
- [ ] Preserve-last-N algorithm with dynamic N fallback
- [ ] Session compaction failure recovery (fall back to truncation)
- **AC**: Multi-turn conversation works

### Phase 6: Embeddings
- [ ] `POST /v1/embeddings`
- [ ] Embedding provider routing precedence (request model → global `embeddingProvider` → any capable provider)
- **AC**: Can embed text

### Phase 7: Resilience
- [ ] Retry with backoff
- [ ] Concurrency pools
- [ ] SSE backpressure handling (capped event buffer, stale connection detection)
- **AC**: Handles provider failures

---

## Development Philosophy

### Fail-Fast

- Uncaught exceptions reveal bugs
- Fix the cause, not the symptom
- No defensive try/catch without recovery

### Code Style

- No comments - code must be self-evident
- Functional preference
- Reliability > Performance > Human Readability

---

## Configuration Reference

### `compaction.targetRatio`

Target compression ratio. A value of `0.3` means "compress to approximately 30% of the original token count." Used by the compaction algorithm to determine when a summary is sufficiently reduced.

### `tokenEstimation.strategy`

Tiered token estimation strategy:
1. **`"auto"` (default):** Use provider's native tokenizer API if available (e.g., Gemini's `countTokens`), fall back to tiktoken with appropriate encoding (e.g., `cl100k_base`), then fall back to character-based heuristic (`length * fallbackRatio`).
2. **`"heuristic"`:** Always use `length * fallbackRatio` (fast but imprecise).

### `compaction.heartbeatIntervalMs`

Interval (ms) for emitting SSE heartbeat comments (`: heartbeat\n\n`) during long compaction operations. Prevents proxy/load-balancer timeouts and enables stale connection detection. Default: 15000.

### `routing.embeddingProvider`

Default provider for embedding requests. Precedence for `/v1/embeddings`:
1. If request specifies a namespaced model (e.g., `ollama:nomic-embed`), route to that provider
2. If request specifies a model name, search all providers with `embeddings: true` capability
3. Fall back to `embeddingProvider` config value
4. Fall back to `defaultProvider` if it has `embeddings: true`

---

## Conventions

### Field Naming

- **Internal code:** camelCase (`preserveRecent`, `contextWindow`, `maxTokens`)
- **API payloads (request/response JSON):** snake_case (`preserve_recent`, `context_window`, `max_tokens`)
- **HTTP headers:** X-Prefixed-Kebab-Case (`X-Session-Id`, `X-Provider`, `X-Async`)

Translation happens at the API boundary layer (route handlers).

---

## License

MIT
