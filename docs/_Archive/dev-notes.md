# LLM Gateway - Developer Notes

Technical documentation for developers working on or extending the LLM Gateway.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Provider Adapters](#provider-adapters)
4. [Context Window Management](#context-window-management)
5. [Configuration](#configuration)
6. [Circuit Breakers & Resilience](#circuit-breakers--resilience)
7. [Media Generation (Phase 2)](#media-generation-phase-2)
8. [Development Philosophy](#development-philosophy)
9. [Testing](#testing)

---

## Architecture Overview

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

The LLM Gateway is a high-performance, centralized OpenAI-compatible HTTP facade application meant to intercept, route, and natively mitigate context-window bound failures for massive prompts. It interacts directly with locally-hosted or remote LLMs while avoiding large external dependencies.

### Core Components

1. **Provider Adapters** - Normalize disparate provider APIs into standard OpenAI interfaces
2. **Router** - Intelligent routing with capability-based filtering
3. **Context Manager** - Handles oversized prompts through compaction strategies
4. **Session Store** - In-memory conversation state with TTL
5. **Circuit Breakers** - Protect downstream endpoints from cascading failures

---

## Project Structure

```
src/
├── main.js              # Application entry point
├── config.js            # Configuration loader with env substitution
├── app.js               # Express app setup
├── routes/
│   ├── completions.js   # POST /v1/chat/completions
│   ├── embeddings.js    # POST /v1/embeddings
│   ├── models.js        # GET /v1/models
│   ├── sessions.js      # Session management endpoints
│   ├── health.js        # GET /health
│   └── tasks.js         # Ticket-based async tasks
├── core/
│   ├── router.js        # Provider selection and routing logic
│   ├── circuit-breaker.js  # Circuit breaker implementation
│   └── pool.js          # Concurrency pool management
├── adapters/            # Provider adapters
│   ├── base.js          # Base adapter interface
│   ├── lmstudio.js      # LM Studio adapter
│   ├── ollama.js        # Ollama adapter
│   ├── gemini.js        # Google Gemini adapter
│   ├── openai.js        # OpenAI-compatible adapters
│   ├── minimax.js       # MiniMax adapter
│   ├── kimi-cli.js      # Kimi CLI adapter
│   └── adapters.md      # Detailed adapter documentation
├── context/             # Context window management
│   ├── estimator.js     # Token estimation
│   ├── strategy.js      # Compaction strategies
│   └── manager.js       # Context manager
├── sessions/
│   └── store.js         # In-memory session storage
└── utils/
    ├── sse.js           # SSE streaming utilities
    └── fn.js            # Functional utilities
```

---

## Provider Adapters

### Adapter Interface

All adapters must implement the following interface:

```javascript
const createAdapter = (config) => ({
  name: 'adapter_name',
  capabilities: {
    embeddings: true,
    structuredOutput: true,
    streaming: true
  },
  
  // Required methods
  async resolveModel(requestedModel) { ... },
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
  
  // Optional methods
  async countTokens(text) { ... },
  async loadModel(modelName) { ... },
  async unloadModel(modelName) { ... }
});
```

### Supported Providers

See [src/adapters/adapters.md](../src/adapters/adapters.md) for detailed documentation on each provider:

| Provider | Adapter Type | Embeddings | Streaming | JSON Mode |
|----------|--------------|------------|-----------|-----------|
| Gemini | `gemini` | ✅ | ✅ | ✅ |
| LM Studio | `lmstudio` | ✅ | ✅ | ✅ |
| Ollama | `ollama` | ✅ | ✅ | ❌ |
| Grok | `openai` | ❌ | ✅ | ✅ |
| MiniMax | `minimax` | ❌ | ❌ | ✅ |
| GLM | `openai` | ❌ | ✅ | ✅ |
| Kimi | `kimi-cli` | ❌ | Simulated | ❌ |
| Qwen | `openai` | ❌ | ✅ | ✅ |

### Capability-Based Routing

The router checks adapter capabilities before routing:

- **Structured Output:** Requests with `response_format: { type: "json_schema" }` are only routed to providers with `structuredOutput: true`
- **Embeddings:** Requests to `/v1/embeddings` are routed to providers with `embeddings: true`
- **Streaming:** All providers support streaming via `streamComplete()`

---

## Context Window Management

### Compaction Trigger

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

### Compaction Algorithm

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

### Token Estimation Strategy

The `tokenEstimation.strategy` config controls estimation:

1. **`"auto"` (default):** 
   - Use provider's native tokenizer API if available (e.g., Gemini's `countTokens`)
   - Fall back to tiktoken with appropriate encoding
   - Fall back to character-based heuristic (`length * fallbackRatio`)

2. **`"heuristic"`:** 
   - Always use `length * fallbackRatio` (fast but imprecise)

### `compaction.targetRatio`

Target compression ratio. A value of `0.3` means "compress to approximately 30% of the original token count." Used by the compaction algorithm to determine when a summary is sufficiently reduced.

---

## Configuration

### Environment Variable Substitution

The `config.json` supports environment variable substitution using `${VAR_NAME}` syntax:

```json
{
  "providers": {
    "gemini": {
      "apiKey": "${GEMINI_API_KEY}"
    }
  }
}
```

At runtime, `${GEMINI_API_KEY}` is replaced with `process.env.GEMINI_API_KEY`.

### Configuration Schema

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
    // Provider configurations
  }
}
```

### Provider Configuration

```json
{
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
    }
  }
}
```

---

## Circuit Breakers & Resilience

### Circuit Breaker (`src/core/circuit-breaker.js`)

Wraps LLM interactions counting sequential failures and returning `503 Unavailable` while dropping requests before executing timeouts.

- **Closed State:** Normal operation, requests pass through
- **Open State:** After threshold failures, fast-fail with 503
- **Half-Open State:** Test if provider recovered

### Concurrency Pools (`src/core/pool.js`)

Each provider has a configurable concurrency pool:

- `maxConcurrent`: Maximum simultaneous requests
- `queueDepth`: Maximum queued requests before rejecting with 429

### Retry Logic

Per-provider retry configuration:

```json
{
  "retry": {
    "enabled": true,
    "maxAttempts": 3,
    "backoffMs": 1000,
    "retryOn": [502, 504, "ETIMEDOUT", "ECONNREFUSED"]
  }
}
```

### SSE Backpressure Handling

- Capped event buffer to prevent memory exhaustion
- Periodic heartbeat comments (`: heartbeat`) for stale connection detection
- `drain` handler for Node.js backpressure

---

## Media Generation (Phase 2)

Phase 2 adds OpenAI-compatible media generation routes while preserving gateway reliability patterns:

- `POST /v1/images/generations` → forced async (`202 + ticket`)
- `POST /v1/audio/speech` → synchronous binary response

### Router Flow

`Router` now exposes two route-level media methods:

1. `routeImageGeneration(payload, headers)`
   - Resolves provider/model with capability gating (`imageGeneration: true`)
   - Creates a ticket and executes image generation in background
   - Logs `media_generation_latency`
2. `routeAudioSpeech(payload, headers)`
   - Resolves provider/model with capability gating (`tts: true`)
   - Executes adapter TTS call synchronously and returns binary payload metadata

### Capability Negotiation

Adapter capability shape now includes:

```json
{
  "capabilities": {
    "imageGeneration": false,
    "tts": false,
    "stt": false
  }
}
```

Router rejects capability mismatches with `422 Unprocessable Entity` rather than attempting unsupported provider translation.

### Temporary Media Storage

Media staging is implemented by `MediaStorage` (`src/utils/storage.js`):

- Stores generated files under configurable temp directory
- Serves files via `/v1/media/*`
- Runs interval-based TTL eviction (`ttlMinutes`)
- Logs `evicted_files_count` when cleanup removes stale files

### Async Observability

Ticket polling logs `async_ticket_age_before_poll=<ms>` on first `GET /v1/tasks/:id` request to help identify client polling delays.

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

### Field Naming Conventions

- **Internal code:** camelCase (`preserveRecent`, `contextWindow`, `maxTokens`)
- **API payloads:** snake_case (`preserve_recent`, `context_window`, `max_tokens`)
- **HTTP headers:** X-Prefixed-Kebab-Case (`X-Session-Id`, `X-Provider`, `X-Async`)

Translation happens at the API boundary layer.

---

## Testing

### Test Organization

| Command | Scope | Requires Running Server | Requires LLM Backend |
|---------|-------|------------------------|---------------------|
| `npm test` | Unit tests only | No | No |
| `npm run test:watch` | Unit tests in watch mode | No | No |
| `npm run test:integration` | End-to-end integration tests | Yes | Auto-detected |
| `npm run test:providers` | Per-provider endpoint tests | Yes | Auto-detected |
| `npm run test:all` | All test files combined | Yes | Auto-detected |

### Unit Tests

Run against the in-process Express application via supertest. No live server or LLM backend required.

Test files:
- `tests/server.test.js` — Server routing & API architecture (13 tests)
- `tests/adapters.test.js` — Provider adapters interface (6 tests)
- `tests/adapter.gemini.test.js` — Gemini adapter workflows (6 tests)
- `tests/config.test.js` — Configuration manager (2 tests)
- `tests/context.test.js` — Context window management (9 tests)
- `tests/router.test.js` — Intelligent router (11 tests)
- `tests/resilience.test.js` — Circuit breaker (3 tests)
- `tests/streaming.test.js` — Streaming & SSE (2 tests)
- `tests/sessions.flow.test.js` — Session chat flow (1 test)
- `tests/load.test.js` — Load testing & memory bounds (1 test)

### Integration Tests

Make real HTTP requests against the **live running gateway**. Tests probe all configured providers and automatically skip LLM-dependent tests when no backend is reachable.

Key features:
- **Provider auto-detection:** Probes health and attempts a chat completion
- **Graceful skipping:** LLM-dependent tests show as `pending` when no backend is up
- **Session memory:** Verifies contextual recall across multiple turns

### Provider Endpoint Tests

Runs a standardized battery of tests against **each individually configured provider**. Each test sends requests with the `X-Provider` header forcing traffic to that specific backend.

| Test | What It Verifies |
|------|-----------------|
| Chat completion | Non-streaming request returns valid response |
| Streaming | SSE chunks are delivered and assemble coherent text |
| Embeddings | Returns embedding vectors (skipped if not capable) |
| Structured output | JSON mode returns parseable JSON (skipped if not capable) |
| Models | `/v1/models` returns a list for this provider |
| System prompt | Model follows explicit system instructions |
| Multi-turn | Model handles conversation context |

---

## References

- [Provider Adapters Documentation](../src/adapters/adapters.md) - Detailed adapter documentation
- [API Documentation](./api_documentation.md) - Complete API reference
