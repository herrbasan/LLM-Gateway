# LLM Gateway - Comprehensive Project Documentation

## 1. Project Overview

The **LLM Gateway** is a high-performance, centralized OpenAI-compatible HTTP facade application meant to intercept, route, and natively mitigate context-window bound failures for massive prompts. It interacts directly with locally-hosted or remote LLMs while avoiding large external dependencies. 

By unifying requests across disparate vendors (Ollama, LM Studio, Gemini, Grok, GLM, etc.) and seamlessly intercepting payloads that exceed context window horizons, it protects the downstream LLM from crashing (`413 Payload Too Large`), ensuring consistent completions through chunked extraction and dynamic tracking.

---

## 2. Completed Architecture & Implemented Features

### 2.1 Core API (OpenAI-Compatible)
The service natively serves the following Standardized OpenAI ecosystem endpoints:
- `POST /v1/chat/completions`: Single and stream responses supporting all standard capabilities.
- `POST /v1/embeddings`: Batch and single embedding support.
- `GET /v1/models`: Aggregates the deployed adapters and models with capabilities arrays.

### 2.2 Provider Adapters (The Engine)
Fully isolated provider adapters obeying a strict protocol contract (`src/adapters/base.js`).
- Supported Adapters: **LM Studio**, **Ollama**, **Gemini**, **OpenAI**. (With further scaling provided for Kimi, Minimax, GLM, Grok, etc.).
- Capabilities mapping prevents `response_format: { type: "json_schema" }` routing to providers lacking `structuredOutput` capabilities.
- Dynamic fallback routing parses definitions automatically (e.g., `model: "ollama:llama3"` routing bounds).

### 2.3 Context Window Management Interceptor
A massive feature that handles oversized prompts that exceed either an arbitrary floor (`minTokensToCompact`) or an absolute hard-limit of available tokens. Strategies map gracefully under `src/context/strategy.js`:
- **Truncate (Sliding Window)**: Retains system prompts and strips older internal sliding messages based on `preserveLastN`.
- **Compress (Single-Pass)**: Leverages an inline-instantiated agent model via the active adapter to summarize context aggressively retaining user tokens.
- **Rolling (Chained Chunking)**: Reassembles large inputs by chunking them asynchronously across consecutive summary chains.

### 2.4 Streaming Data Handling & Backpressure
Engineered for raw stability with immense chunk footprints. Extends `sse.js` via Node streams to effectively support:
- `Drain` detection on interceptors ensuring massive stream chunks block upstream outputs to preserve RAM (preventing V8 Out-Of-Memory Heap failures).
- Stream Keep-Alives via constant `: heartbeat` pings per HTTP connections keeping proxies open.

### 2.5 Resilient Circuit Breakers & Pool Managers
- **Circuit Breaker (`src/core/circuit-breaker.js`)**: Wraps LLM interactions counting sequential failures and returning `503 Unavailable` while dropping requests before executing timeouts.
- **Fail-Fast Boot**: The server parses and strictly throws during initial Boot configurations.

### 2.6 Stateful Session API
- `POST /v1/sessions`: Exposes tokenized conversational states wrapped internally in RAM, keyed by a `X-Session-Id` header appending memory transparently (Includes strict 1-hr TTL).

---

## 3. Discrepancies and Missing Implementations (To-Do)

While reviewing the current workspace implementation against the original `DEV_PLAN.md` and `LLM_GATEWAY_SPEC.md`, **the following specifications are incomplete or omitted:**

1. **Async Ticket Flow (`X-Async: true`)**:
   - *Spec Requirement:* Provide non-blocking `202 Accepted` tasks dynamically tracking compaction pipelines without halting web processes.
   - *Current State:* Missing. The Router dynamically holds the connection over synchronous async context processing (`this.contextManager.compress(...)`) regardless of prompt scale. The `X-Async` header is ignored, and there is no active `Ticket Registry` or `GET /v1/tasks/:id` endpoint mapped to `routes/tasks.js`.
   
2. **Intermediate SSE Compaction Progress Events**:
   - *Spec Requirement:* While streaming large prompts, return generic `event: compaction.progress` updates prior to output tokens for UI loading displays.
   - *Current State:* Missing. `StreamHandler` exclusively processes final execution chunks dynamically mapped from active Completion calls, without ingesting mid-cycle summary telemetry.
   
3. **Tiktoken Estimation Tier**:
   - *Spec Requirement:* A 3-tiered estimation block (`Native API` -> `Tiktoken` -> `Length Heuristic`). 
   - *Current State:* Safely omitted. `estimator.js` evaluates through `Native API` dynamically and gracefully defaults blindly to the `Character Fallback Heuristic`. The `Tiktoken` integration has been skipped to likely minimize large Wasm/native binary builds on cold starts.
   
---

## 4. Configuration Schema

The execution is wholly bound via explicit instructions declared inside `config.json`. Sample configurations manage standard system bounds transparently:

```json
{
  "port": 3400,
  "compaction": {
    "enabled": true,
    "minTokensToCompact": 2000,
    "preserveSystemPrompt": true,
    "preserveLastN": 4
  },
  "routing": {
    "defaultProvider": "lmstudio",
    "embeddingProvider": "ollama"
  },
  "providers": {
     // Configured adapter mappings supporting runtime ${} Environment replacement
  }
}
```

---

## 5. Next Steps

To fully reach the 100% boundary of the Initial App Spec:
1. Abstract `TicketRegistry` class tracking Maps in server memory.
2. Bridge async tickets to a new streaming controller emitting JSON chunks defining completion blocks over `/v1/tasks/:id/stream`.
3. Wrap context execution returns with dynamic generator `yield` patterns supporting `event: compaction.X` tags prior to standardizing `[DONE]`.

---

## 6. Test Suite

The project uses **Mocha** + **Chai** for assertions and **supertest** for HTTP-level unit tests. Tests are organized into three tiers: unit tests (run offline against the Express app object), integration tests (run against the live gateway), and provider endpoint tests (validate each configured LLM backend individually).

### 6.1 npm Scripts

| Command | Scope | Requires Running Server | Requires LLM Backend |
|---|---|---|---|
| `npm test` | Unit tests only (55 tests) | No | No |
| `npm run test:watch` | Unit tests in watch mode | No | No |
| `npm run test:integration` | End-to-end integration tests | Yes | Auto-detected |
| `npm run test:providers` | Per-provider endpoint tests | Yes | Auto-detected |
| `npm run test:all` | All test files combined | Yes | Auto-detected |

### 6.2 Unit Tests (`npm test`)

These run against the in-process Express application via supertest. No live server or LLM backend is required.

#### `tests/server.test.js` — Server Routing & API Architecture (13 tests)
Validates all HTTP endpoints are wired correctly, middleware behaviour, and error code mapping.
- **Health**: `GET /health` returns 200 with status `ok`.
- **Error handling**: Unknown routes return 404; CORS `OPTIONS` returns proper headers.
- **Chat completions**: Route hooks up and rejects unknown models with 404.
- **Embeddings**: Route triggers and returns 404 for unknown models.
- **Models**: `GET /v1/models` returns object type `list`.
- **Sessions API**: Full CRUD lifecycle — create, retrieve, patch, delete — plus 404 on missing sessions.
- **Error code mapping**: Validates 404 for missing sessions, 400 for structured output on non-capable providers, 404 for unknown adapters.

#### `tests/adapters.test.js` — Provider Adapters (6 tests)
Verifies the adapter factory and interface contracts.
- Instantiates only valid adapters; skips misconfigured or unknown types.
- Each adapter type (LM Studio, Ollama, Gemini, OpenAI) exposes the required interface: `predict()`, `streamComplete()`, `embedText()`, `countTokens()`, `getContextWindow()`, `resolveModel()`.
- The `auto` model identifier resolves correctly per adapter.

#### `tests/adapter.gemini.test.js` — Gemini Adapter Live Workflows (6 tests)
Live tests against the Gemini API validating the native adapter translation layer.
- Token counting via the native Gemini `countTokens` endpoint.
- Standard completion (`predict`) preserving OpenAI response format.
- Structured JSON output with `response_format` enforcement.
- System instruction mapping into Gemini's native `systemInstruction` field.
- Streaming via `streamComplete()` yielding OpenAI-compatible SSE chunks.
- Batch text embeddings via `embedText()`.

#### `tests/config.test.js` — Configuration Manager (2 tests)
- Loads `config.json` without throwing.
- Substitutes `${ENV_VAR}` placeholders from `.env` at runtime.

#### `tests/context.test.js` — Context Window Management (9 tests)
Exercises the token estimation and compaction strategies end-to-end through the Router.
- Token estimation via character heuristic fallback.
- **Truncate**: Strips older messages while preserving system prompt and `preserveLastN`.
- **Compress**: Triggers single-pass summarization when tokens exceed thresholds.
- Threshold guards: No compaction when tokens are below `minTokensToCompact` or when they fit the context window.
- Per-request `context_strategy` overrides (mode `none` returns 413; mode `truncate` overrides global `none`).
- Context metadata attachment in non-streaming responses.
- Async ticket issuance when `X-Async: true` and compaction is needed.

#### `tests/router.test.js` — Intelligent Router (11 tests)
Tests provider resolution, model routing, and capability gates.
- Routes to default provider when no overrides are given.
- `X-Provider` header overrides the provider selection.
- Namespaced model syntax (`ollama:llama3`) selects the correct adapter.
- Unknown provider/model combinations fail fast with descriptive errors.
- Structured output (`json_object`, `json_schema`) is blocked for non-capable providers and allowed for capable ones.
- **Embeddings routing**: Namespaced providers, `embeddingProvider` config fallback, auto-discovery of first capable provider, and `embedBatch` array input handling.

#### `tests/resilience.test.js` — Resilience & Circuit Breaker (3 tests)
Validates circuit-breaker behaviour under failure conditions.
- `/health` endpoint exposes per-provider metrics (state, failure count, request counts).
- Sequential failures trip the circuit breaker to `OPEN` state.
- Once tripped, subsequent requests fail fast with 503 without reaching the backend.

#### `tests/streaming.test.js` — Streaming & SSE (2 tests)
Unit tests for the `StreamHandler` class with mock responses.
- Sets correct headers (`text/event-stream`, `no-cache`, `keep-alive`), formats `data:` lines, and terminates with `data: [DONE]`.
- Injects `: heartbeat` comments at the configured interval.

#### `tests/sessions.flow.test.js` — Session Chat Flow (1 test)
End-to-end session flow via supertest verifying that message history accumulates across multiple chat completions bound to the same `X-Session-Id`.

#### `tests/load.test.js` — Load Testing & Memory Bounds (1 test)
Stress-tests the streaming pipeline with high-volume concurrent connections to verify Node.js backpressure handling and stable memory usage under load.

### 6.3 Integration Tests (`npm run test:integration`)

**File:** `tests/integration.test.js` — 29 tests across 11 categories.

These tests make real HTTP requests (native `fetch()`) against the **live running gateway** on `http://localhost:3400` (configurable via `LLM_GW_URL` env var). On startup, the suite probes all configured providers and automatically skips LLM-dependent tests when no backend is reachable.

| Category | Tests | Requires LLM |
|---|---|---|
| Health | 2 | No |
| Models | 2 | Yes |
| Chat completions (non-streaming) | 5 | 4 yes, 1 no |
| Streaming SSE | 2 | Yes |
| Sessions lifecycle | 6 | 4 no, 2 yes |
| Embeddings | 2 | Yes |
| Structured output / JSON mode | 1 | Yes |
| Multi-turn stateless conversation | 1 | Yes |
| Error handling | 6 | No |
| Concurrency (3 parallel requests) | 1 | Yes |
| CORS | 1 | No |

**Key features:**
- **Provider auto-detection**: Probes health and attempts a chat completion; discovers which providers are live.
- **Graceful skipping**: LLM-dependent tests show as `pending` (not `failing`) when no backend is up.
- **Session memory**: Sends "My favourite colour is blue", then asks "What is my favourite colour?" in a follow-up to verify contextual recall.
- **SSE collector**: Parses `data:` lines from chunked streaming responses and reassembles the full text.

### 6.4 Provider Endpoint Tests (`npm run test:providers`)

**File:** `tests/providers.test.js` — 7 tests per provider, dynamically generated.

Runs a standardized battery of tests against **each individually configured provider** (lmstudio, ollama, gemini, grok, kimi, glm, minimax, qwen). Each test sends requests with the `X-Provider` header forcing traffic to that specific backend.

| Test | What It Verifies |
|---|---|
| Chat completion | Non-streaming request returns a valid response with content |
| Streaming | SSE chunks are delivered and assemble coherent text |
| Embeddings | Returns embedding vectors (skipped if provider lacks capability) |
| Structured output | JSON mode returns parseable JSON (skipped if not capable) |
| Models | `/v1/models` returns a list for this provider |
| System prompt | Model follows explicit system instructions |
| Multi-turn | Model handles conversation context across message pairs |

**Key features:**
- **Capability-aware**: Reads `config.json` capability flags; skips embeddings/structured output tests for providers that don't support them.
- **Resilient**: Any non-200 response (502, 503, 400 auth errors, 500 unresolved env vars) causes the test to skip with a diagnostic message rather than fail.
- **Diagnostic output**: Logs response snippets, embedding dimensions, chunk counts, and JSON payloads for quick visual verification.

### 6.5 Running Tests

```bash
# Unit tests (no server required)
npm test

# Start the gateway, then run integration or provider tests
npm start
npm run test:integration    # in a second terminal
npm run test:providers      # in a second terminal

# Run everything
npm run test:all

# Override gateway URL for remote testing
LLM_GW_URL=http://remote-host:3400 npm run test:integration
```