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