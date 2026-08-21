# LLM Gateway API Documentation v2.0

Complete API reference for the LLM Gateway v2.0 (model-centric, stateless architecture).

---

## Table of Contents

1. [API Design Philosophy](#api-design-philosophy)
2. [Response Patterns](#response-patterns)
3. [Endpoints Reference](#endpoints-reference)
4. [Task-Based Query System](#task-based-query-system)
5. [Ticket-Based API](#ticket-based-api)
6. [System Events](#system-events)
7. [Usage Patterns](#usage-patterns)
8. [Error Handling](#error-handling)
9. [Client Library Design](#client-library-design)

---

## API Design Philosophy

### Stateless Architecture

The gateway is **stateless**. Clients send full message history with each request. There is no session management, no `X-Session-Id` header, and no server-side conversation state.

### Unified Response Model

All chat requests go to one endpoint. By default, all responses are OpenAI-compatible `200 OK`. The `202` ticket flow is opt-in only via `X-Async: true` header.

| Prompt Size | Default Response | With `X-Async: true` |
|-------------|-----------------|----------------------|
| Fits in context | `200 OK` — immediate response | `200 OK` — immediate response |
| Exceeds context | `413 Payload Too Large` — client owns compaction | `202 Accepted` — ticket created, client polls for result |

### Unified Streaming

All streaming uses a single SSE connection:

```bash
POST /v1/chat/completions
{ "stream": true, "messages": [...] }

# Tokens stream immediately
data: {"choices":[{"delta":{"content":"Hello"}}]}

# With X-Async: true: returns 202 + ticket, client connects to task stream
```

> **Backpressure:** If the client reads slowly, SSE events buffer in memory. The server emits periodic heartbeat comments (`: heartbeat`) to detect stale connections, and caps the internal event buffer to prevent memory exhaustion.

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

### Pattern 2: Large Prompt → 413 Payload Too Large

For oversized prompts, the gateway does not silently compact. The client is responsible for truncating or summarising its own history before retrying. The gateway returns `413 Payload Too Large` so the client can react explicitly:

```bash
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "...(oversized)..."}]
}
```

**Response:** HTTP `413` with a JSON error body describing the size limit and the model's `contextWindow`.

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
  "estimated_chunks": 1,
  "stream_url": "/v1/tasks/tkt_xyz789/stream"
}
```

---

## Endpoints Reference

### POST /v1/chat/completions

Main chat completion endpoint. Supports both streaming and non-streaming responses.

If `max_tokens` is omitted, the gateway derives a safe output budget from the model's configured `capabilities.contextWindow`, the estimated prompt size, and an internal safety margin. The resolved value is reported back in the response `context` payload.

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |
| `X-Async` | `true` to get 202 + ticket for async processing | No |
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
  "strip_thinking": true,
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "response", "strict": true, "schema": {...} }
  },
  "image_processing": {
    "resize": "auto",
    "transcode": "webp",
    "quality": 85
  }
}
```

> **Thinking Stripper:** When `strip_thinking: true` (or `no_thinking: true`) is provided, and the model outputs reasoning/thinking tokens (like DeepSeek `<think` blocks or native `reasoning_content`), the gateway will automatically strip the reasoning portion. This works seamlessly for both standard and streaming requests, ensuring clean JSON/markdown outputs.

> **Image Processing:** The `image_processing` field is optional. When provided, images in messages are fetched (remote URLs) and optionally resized/transcoded via MediaService. See [Vision (Image Input)](#vision-image-input) for complete examples.

**Response 200:**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1739999999,
  "model": "gemini-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." }
  }],
  "context": {
    "window_size": 1048576,
    "used_tokens": 2800,
    "available_tokens": 1045776
  }
}
```

The `context` object is gateway telemetry (window size, estimated usage). It is not part of the OpenAI Chat Completions spec and is omitted from spec-compliant responses.

**Response 202 (With `X-Async: true`):**

```json
{
  "object": "chat.completion.task",
  "ticket": "tkt_xyz789",
  "status": "accepted",
  "estimated_chunks": 1,
  "stream_url": "/v1/tasks/tkt_xyz789/stream"
}
```

---

### POST /v1/responses

OpenAI Responses API proxy endpoint. Supports both streaming and non-streaming responses.

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |

**Request Body:**

```json
{
  "model": "openai-responses",
  "input": "Explain quantum computing",
  "stream": true
}
```

The gateway routes to a model configured with the `responses` adapter, which proxies to the OpenAI Responses API format. Streaming responses use SSE events with `event: type` prefixes.

**Response 200 (non-streaming):**
```json
{
  "id": "resp-xxx",
  "object": "response",
  "model": "openai-responses",
  "output": [...]
}
```

**Streaming Response:**
```
event: response.output_item.added
data: {...}

event: response.content_part.added
data: {...}

event: response.output_text.delta
data: {"delta": "Hello"}

data: [DONE]
```

If the HTTP client disconnects during streaming, the gateway aborts the upstream provider request.

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

data: {"id":"chatcmpl-gw-...","object":"chat.completion.chunk","created":...,"model":"","choices":[],"usage":{"prompt_tokens":2800,"completion_tokens":0,"total_tokens":2800}}

data: [DONE]
```

> Oversized streaming requests are rejected with `413 Payload Too Large` (or a `202 Accepted` ticket if `X-Async: true` was set). The gateway does not inject gateway-specific progress events into the stream.

If the HTTP client disconnects during streaming or before a non-streaming response completes, the gateway aborts the upstream provider request for fetch-based chat adapters instead of continuing generation in the background.

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

### GET /health

Health check endpoint with adapter status and circuit breaker stats.

```bash
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "version": "2.0.0",
  "adapters": {
    "gemini": {
      "chat": { "state": "CLOSED", "failures": 0, "successes": 42, "lastFailure": null },
      "stream": { "state": "CLOSED", "failures": 0, "successes": 42, "lastFailure": null },
      "embed": { "state": "CLOSED", "failures": 0, "successes": 10, "lastFailure": null }
    },
    "openai": {
      "chat": { "state": "CLOSED", "failures": 0, "successes": 15, "lastFailure": null }
    }
  },
  "models": ["gemini-flash", "local-llama", "openai-gpt4"]
}
```

---

### GET /help

Returns API documentation rendered as HTML.

```bash
GET /help
```

---

### GET /config

Get raw gateway configuration. **Restricted to localhost only.**

```bash
GET /config
```

**Response:** Raw JSON config object.

---

### POST /config/store

Save configuration and hot-reload the gateway. **Restricted to localhost only.**

```bash
POST /config/store
Content-Type: application/json
```

**Request Body:** Full JSON config object.

**Response:**
```json
{
  "success": true,
  "message": "Configuration saved and reloaded"
}
```

The gateway reloads the model router dynamically without restarting.

---

### GET /logs

Queryable structured log access.

```bash
GET /logs
GET /logs?level=ERROR,WARN
GET /logs?type=ChatRoute
GET /logs?sessionId=abc123
GET /logs?limit=50
```

**Query Parameters:**

| Parameter | Description | Default |
|-----------|-------------|---------|
| `level` | Comma-separated log levels (`INFO`, `WARN`, `ERROR`, `DEBUG`) | All levels |
| `type` | Comma-separated log types (case-insensitive) | All types |
| `sessionId` | Filter by session ID from log filename | All sessions |
| `limit` | Maximum entries to return | 100 |

**Response:**
```json
{
  "logs": [
    {
      "timestamp": "2026-05-23T10:30:45.123Z",
      "level": "INFO",
      "type": "ChatRoute",
      "message": "Chat completion request received",
      "payload": { "model": "gemini-flash" },
      "sessionId": "abc123"
    }
  ]
}
```

---

### GET|POST /logs/level

Runtime log-level control (localhost-only). The gateway runs quiet by default (errors only).

```bash
GET /logs/level
# → { "level": "error", "levels": ["debug", "info", "warn", "error"] }

POST /logs/level
Content-Type: application/json
{ "level": "debug" }
# → { "level": "debug", "previous": "error" }
```

- `GET` returns the current level and the valid levels.
- `POST` sets the level; returns the new and previous values.
- Invalid levels → `400`. Non-localhost callers → `403`.

---

## Task-Based Query System

Tasks provide semantic routing with preset parameters. Instead of specifying a model and tuning parameters for every request, clients reference a named task that encapsulates the model choice, system prompt, temperature, max tokens, and other defaults.

### How Tasks Work

1. Client sends a request with `"task": "task-name"`
2. Gateway looks up the task config and merges its defaults into the request
3. Client-supplied parameters **always override** task defaults
4. If the task defines a `systemPrompt`, it is prepended as the first system message

### GET /v1/tasks

List all available tasks.

```bash
GET /v1/tasks
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "query",
      "object": "task",
      "model": "gemini-flash",
      "description": "General query and conversation"
    },
    {
      "id": "inspect",
      "object": "task",
      "model": "gemini-flash",
      "description": "Code inspection and analysis"
    }
  ]
}
```

### Using Tasks in Chat Requests

```json
POST /v1/chat/completions
{
  "task": "synthesis",
  "messages": [{"role": "user", "content": "Summarize this article..."}],
  "temperature": 0.5
}
```

The `synthesis` task might define `model: "gemini-flash"`, `temperature: 0.3`, `maxTokens: 2048`. The client's `temperature: 0.5` overrides the task default, while `model` and `maxTokens` come from the task.

### Task Configuration

Tasks are defined in `config.json`:

```json
{
  "tasks": {
    "synthesis": {
      "model": "gemini-flash",
      "description": "Content synthesis and summarization",
      "systemPrompt": "Summarize the following content concisely.",
      "maxTokens": 2048,
      "temperature": 0.3
    },
    "inspect": {
      "model": "gemini-flash",
      "description": "Code inspection and analysis",
      "maxTokens": 8192,
      "temperature": 0.1,
      "stripThinking": false,
      "extraBody": {
        "chat_template_kwargs": {
          "enable_thinking": true
        }
      }
    }
  }
}
```

### Supported Task Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | **Required.** Model ID to route to |
| `description` | string | Human-readable description |
| `systemPrompt` | string | Prepended as first system message |
| `maxTokens` | number | Default output token limit |
| `temperature` | number | Sampling temperature (0-2) |
| `topP` | number | Nucleus sampling threshold (0-1) |
| `topK` | number | Top-K sampling limit |
| `stripThinking` | boolean | Override global thinking strip |
| `noThinking` | boolean | Disable model reasoning/thinking |
| `responseFormat` | object | Structured output configuration |
| `extraBody` | object | Adapter-specific passthrough params |
| `presencePenalty` | number | Presence penalty (-2.0 to 2.0) |
| `frequencyPenalty` | number | Frequency penalty (-2.0 to 2.0) |
| `seed` | number | Random seed for reproducibility |
| `stop` | array | Stop sequences |
| `extra_body` | object | Adapter-specific passthrough params (merged into upstream payload) |
| `enable_thinking` | boolean | Enable/disable model reasoning/thinking per-request |
| `chat_template_kwargs` | object | Direct passthrough to OpenAI-compatible endpoints (e.g., `{ enable_thinking: false }`) |

### Override Priority

```
final request = { ...taskDefaults, ...clientRequestBody }
```

Client parameters always win. If neither task nor client specifies a value, the model config or adapter default applies.

### Using Tasks with Other Endpoints

Tasks work with embeddings too:

```json
POST /v1/embeddings
{
  "task": "embed",
  "input": ["text to embed"]
}
```

---

## Ticket-Based API

Used for:

- Chat requests when `X-Async: true` header is set

Without `X-Async`, the gateway returns the chat result directly with no ticket.

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
- Tickets expire after 1 hour and are automatically cleaned up.

### Stream Task Progress

```bash
GET /v1/tasks/tkt_xyz789/stream
Headers: Accept: text/event-stream
```

Task stream emits SSE events:

```
// For streaming chat completions
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":" world"}}]}
data: [DONE]

// Status updates
event: status_update
data: {"status":"processing"}

// Completion (non-streaming)
event: completion.result
data: {"choices":[{...}], "usage": {...}}

// Errors
event: completion.error
data: {"error":"Provider connection failed"}
data: [DONE]
```

---

## System Events

Global SSE endpoint for monitoring gateway-wide events.

### GET /v1/system/events

Subscribe to system-level events: task lifecycle and routing metrics.

```bash
GET /v1/system/events
Headers: Accept: text/event-stream
```

**Event Types:**

| Event | Description |
|-------|-------------|
| `connected` | Initial connection acknowledgment |
| `task.created` | New async task created |
| `task.updated` | Task status changed |

**Example Stream:**
```
event: connected
data: {"message":"System events stream connected","timestamp":1739999999000}

event: task.created
data: {"ticket":"tkt_abc123","status":"accepted"}

event: task.updated
data: {"ticket":"tkt_abc123","status":"complete"}
```

> **Use Case:** Dashboards, monitoring tools, or clients that want real-time visibility into all gateway operations without polling individual tickets.

---

## Usage Patterns

### Model Resolution

| Use Case | Request | Resolution |
|----------|---------|------------|
| Default model | Omit `model` and `task` | Uses the task marked `default: true` for the request type |
| Specific model | `"model": "gemini-flash"` | Looks up model by ID in config |
| Task-based | `"task": "synthesis"` | Uses task's model + defaults, client overrides apply |
| Task with fallback | Embedding task has `fallback` model | Primary fails → switches to fallback for the cooldown (`fallbackCooldownMinutes`, default 1 min). Embeddings only — chat tasks have no fallback by design. |
| List models | `GET /v1/models` | Returns flat list from config |
| List tasks | `GET /v1/tasks` | Returns list of configured tasks |

### Chat Completions

| Use Case | Implementation |
|----------|---------------|
| Small prompt | `200 OK` — immediate response |
| Oversized prompt (default) | `413 Payload Too Large` — client truncates and retries |
| Oversized prompt (async) | `202 Accepted` — requires `X-Async: true` header |
| Streaming | Unified SSE (single token stream) |
| Structured output | `response_format: { type: "json_schema" }` — routed only to models with `structuredOutput` capability |
| Token constraints | `max_tokens` respected by all adapters |
| Thinking control | `enable_thinking` per-request or `extraBody` in config/task |
| Image processing | `image_processing: { resize, transcode, quality }` for automatic optimization |

### Thinking Control

Control whether models produce verbose reasoning/thinking output. REST-only (the WebSocket transport was removed 2026-07-26). Two normalized fields reach the adapters: `enable_thinking` (boolean on/off) and `reasoning_effort` (graduated enum).

**Resolution priority** (highest wins):
1. Request-level `enable_thinking`
2. Request-level `extra_body.chat_template_kwargs.enable_thinking`
3. Request-level `chat_template_kwargs.enable_thinking`
4. Config-level `extraBody.chat_template_kwargs.enable_thinking`
5. Adapter default (model decides)

**REST usage (OpenAI-compliant — via extra_body):**
```json
POST /v1/chat/completions
{
  "model": "my-llama-model",
  "extra_body": { "chat_template_kwargs": { "enable_thinking": false } },
  "messages": [{"role": "user", "content": "Hello"}]
}
```

**REST usage (gateway convenience):**
```json
POST /v1/chat/completions
{
  "model": "my-llama-model",
  "enable_thinking": false,
  "messages": [{"role": "user", "content": "Hello"}]
}
```

**Config default (applies when no request-level param is given):**
```json
"my-llama-model": {
  "adapter": "openai",
  "capabilities": { "thinking": "chat_template_kwargs" },
  "extraBody": { "chat_template_kwargs": { "enable_thinking": false } }
}
```

**Task default:**
```json
"tasks": {
  "fast": { "model": "my-llama-model", "enable_thinking": false }
}
```

**Adapter translation:**

| Adapter | `enable_thinking` becomes |
|---------|--------------------------|
| `openai` | `chat_template_kwargs.enable_thinking` (only if `capabilities.thinking === "chat_template_kwargs"`) |
| `gemini` | `generation_config.thinking_level` (`high`/`minimal`) |
| `anthropic` | `thinking` block |
| `responses` | `reasoning.effort` |

### Reasoning Effort (`reasoning_effort`)

Graduated reasoning control for models that accept effort levels. Canonical levels: `minimal | low | medium | high | xhigh | max`.

- Models declare accepted values in `capabilities.thinkingLevels` (e.g. `["low", "high", "max"]`).
- Request-level `reasoning_effort` (or `extra_body.reasoning_effort`, config `extraBody.reasoning_effort`) is validated against the declared set.
- An undeclared value is mapped to the **nearest declared level** (walking up the canonical scale, ceiling-clamped; `xhigh` caps one step so it never over-provisions to `max`). The mapping is logged at INFO. `'none'` is honored only when declared, otherwise it drops to the lowest declared level.
- Models without `thinkingLevels` drop `reasoning_effort` with a WARN log — the field is never sent upstream undeclared.
- Adapter translation: `openai` → top-level `reasoning_effort` when `capabilities.thinkingEffortField === "reasoning_effort"`; `anthropic` → `output_config.effort`; `gemini` → `generation_config.thinking_level`; `responses` → `reasoning.effort`.

### Vision (Image Input)

Send images to vision-capable models using OpenAI-compatible format.

**Basic Vision Request:**

```json
POST /v1/chat/completions
{
  "model": "gemini-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "What's in this image?" },
      {
        "type": "image_url",
        "image_url": {
          "url": "https://example.com/image.jpg",
          "detail": "auto"
        }
      }
    ]
  }]
}
```

**With Base64 Image:**

```json
{
  "model": "gemini-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      {
        "type": "image_url",
        "image_url": {
          "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."
        }
      }
    ]
  }]
}
```

**With Image Processing:**

```json
{
  "model": "gemini-flash",
  "messages": [...],
  "image_processing": {
    "resize": "auto",
    "transcode": "jpg",
    "quality": 85
  }
}
```

| Parameter | Description |
|-----------|-------------|
| `detail` | `"auto"` (default), `"low"` (512px), `"high"` (max resolution) |
| `resize` | `"auto"` (model limit), `"low"` (512px), `"high"` (max), or number (max pixels) |
| `transcode` | `"jpg"`, `"png"`, `"webp"` - converts image format |
| `quality` | 1-100, for lossy formats (default: 85) |

**Notes:**
- The gateway fetches remote URLs automatically
- Private IP addresses are blocked for security - use base64 for local images
- MediaService resizes while preserving aspect ratio
- Only models with `capabilities.vision: true` support image inputs

### Media Generation

Media generation (text-to-image, text-to-speech, text-to-video) has been removed from the gateway. Speech is handled by the dedicated nVoice/nSpeech services.

### Tool Use / Function Calling

The gateway supports OpenAI-spec compliant tool use (function calling) across both REST and streaming endpoints. This enables coding assistants, agents, and other tool-calling clients to work through the gateway transparently.

**Request with tools:**

```json
POST /v1/chat/completions
{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "List files in the project"}],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Execute a bash command",
        "parameters": {
          "type": "object",
          "properties": {
            "command": { "type": "string", "description": "The command to run" }
          },
          "required": ["command"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true
}
```

**Non-streaming response with tool calls:**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "model": "gemini-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "refusal": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "bash",
          "arguments": "{\"command\":\"ls -la\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "system_fingerprint": null,
  "usage": { "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120 }
}
```

**Streaming tool calls** are emitted as incremental `delta.tool_calls` chunks following the OpenAI SSE format:

```
data: {"id":"...","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":null}]}
data: {"id":"...","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"ls -la\"}"}}]},"finish_reason":"tool_calls"}]}
data: [DONE]
```

**Returning tool results** for the next turn:

```json
POST /v1/chat/completions
{
  "model": "gemini-flash",
  "messages": [
    {"role": "user", "content": "List files in the project"},
    {"role": "assistant", "content": null, "tool_calls": [{"id": "call_abc123", "type": "function", "function": {"name": "bash", "arguments": "{\"command\":\"ls -la\"}"}}]},
    {"role": "tool", "tool_call_id": "call_abc123", "content": "file1.txt\nfile2.txt\nREADME.md"}
  ]
}
```

**Supported parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `tools` | array | Tool definitions (OpenAI format) |
| `tool_choice` | string/object | `"auto"`, `"none"`, `"required"`, or `{ type: "function", function: { name: "..." } }` |
| `parallel_tool_calls` | boolean | Allow multiple tool calls in one response |
| `functions` | array | Legacy function calling (deprecated, forwarded as-is) |
| `function_call` | string/object | Legacy function call control (deprecated, forwarded as-is) |

**Adapter support:**

| Adapter | Tool Support | Notes |
|---------|-------------|-------|
| `openai` | Direct passthrough | OpenAI, xAI, z.ai, llama.cpp, and other OpenAI-compatible providers |
| `anthropic` | Format conversion | OpenAI tools ↔ Claude tool_use |
| `gemini` | Format conversion | OpenAI tools ↔ Gemini functionDeclarations (Interactions API; no `tool_choice`/`tool_config`) |
| `responses` | Format conversion | OpenAI tools ↔ Responses API tool format |

**Response normalization:** All non-streaming tool-call responses include `refusal: null`, `function_call: null`, `tool_calls: null` (when absent), `annotations: []`, and `system_fingerprint: null` for strict client compatibility (OpenAI SDK, VS Code extensions).

---

## Error Handling

| Code | Meaning |
|------|---------|
| 200 | Success |
| 202 | Accepted (async ticket created) |
| 400 | Bad request (wrong model type, missing fields) |
| 403 | Forbidden (disabled model, config access from non-localhost) |
| 404 | Model not found |
| 413 | Payload too large — request exceeds the model's context window |
| 429 | Rate limit or queue full |
| 502 | Provider unavailable |
| 503 | Circuit breaker open |
| 504 | Timeout |

---

## Client Library Design

The ticket system is designed to be abstracted by a client library. Here's the recommended pattern:

### Conceptual API

```javascript
const client = new GatewayClient({ 
  baseUrl: 'http://localhost:3400',
  autoAsync: { threshold: 10000 }  // Auto-use X-Async when >10k tokens
});

// Simple usage — library handles complexity
const response = await client.chat({
  model: 'gemini-flash',
  messages: conversationHistory,
  onProgress: (chunk) => updateUI(chunk)
});

// Explicit async mode
const ticket = await client.chatAsync({
  model: 'gemini-flash',
  messages: veryLargeHistory
});

// Poll with exponential backoff
const result = await ticket.wait({ 
  pollInterval: 500,
  maxWait: 60000 
});

// Or stream progress
for await (const event of ticket.stream()) {
  if (event.type === 'chunk') updateUI(event.data);
  if (event.type === 'status_update') updateStatus(event.status);
}
```

### Library Responsibilities

| Concern | Implementation |
|---------|---------------|
| **Token Estimation** | Estimate payload size client-side to decide sync vs async |
| **Polling Strategy** | Exponential backoff with jitter for `/v1/tasks/:id` |
| **Stream Reconnection** | Auto-reconnect SSE streams with backoff on disconnect |
| **Event Aggregation** | Subscribe to `/v1/system/events` for multi-task monitoring |
| **Error Recovery** | Retry with circuit breaker awareness |

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
      },
      "imageInputLimit": {
        "maxDimension": 2048
      }
    }
  }
}
```

### Model Types

- `chat` - Chat completion models
- `embedding` - Text embedding models

### Capability Fields

**Chat Models:**
- `contextWindow` (number) - Maximum context window in tokens
- `vision` (boolean) - Supports image inputs
- `structuredOutput` (boolean | string) - Supports JSON output (`true`, `"json_schema"`, or `"json_object"`)
- `streaming` (boolean) - Supports streaming responses
- `maxOutputTokens` (number) - Output token budget used when the client omits `max_tokens` (required for Anthropic-adapter models)
- `thinking` (string) - `"chat_template_kwargs"` gates `enable_thinking` passthrough for OpenAI-adapter models
- `thinkingLevels` (array) - Declared `reasoning_effort` values (e.g. `["low", "high", "max"]`) — see Reasoning Effort
- `thinkingEffortField` (string) - `"reasoning_effort"` makes the openai adapter pass effort through as a top-level field
- `excludeParams` (array) - Parameter names stripped from the upstream payload (for reasoning models that reject sampling params)
- `tools` (boolean) - Supports function calling

**Embedding Models:**
- `contextWindow` (number) - Maximum input tokens
- `dimensions` (number) - Output embedding dimensions

---

## Migration from v1.x

### Removed Features

- **Sessions** - No `X-Session-Id` header, no session endpoints
- **Provider-centric routing** - Models are referenced by ID, not `provider:model`
- **Capability inference** - All capabilities explicitly declared
- **WebSocket transport** (removed 2026-07-26) - REST/SSE only; no `chat.cancel`, no binary WS uploads, no `gateway-media://` scheme
- **Per-provider adapters** (`llamacpp`, `kimi`, `alibaba`, `dashscope`, `ollama`, `lmstudio`) - Replaced by four protocol adapters; providers are now endpoint config (llama.cpp via `openai` adapter)
- **Media generation** (image/audio/video types, `/v1/videos/generations`) - Removed; speech handled by dedicated nVoice/nSpeech services

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

**v2.0:**
```javascript
// Send full history each time
await fetch('/v1/chat/completions', {
  body: JSON.stringify({
    model: 'gemini-flash',
    messages: fullHistory
  })
});

// Or use async mode for large payloads
await fetch('/v1/chat/completions', {
  headers: {'X-Async': 'true'},
  body: JSON.stringify({
    model: 'gemini-flash',
    messages: veryLargeHistory
  })
});
// Then poll /v1/tasks/{ticket} or stream /v1/tasks/{ticket}/stream
```
