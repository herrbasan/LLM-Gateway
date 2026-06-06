# LLM Gateway

> **CRITICAL AI AGENT RULE: DO NOT KILL NODE PROCESSES**
> **NEVER use `taskkill`, `Stop-Process`, `kill`, or any other commands to stop or manage Node processes. This machine runs multiple unrelated background node services. Let the user handle ALL server restarts and process management. NEVER start or stop node processes yourself.**
>
> **CRITICAL SECURITY RULE: DO NOT PUSH `config.json` TO REMOTES**
> **`config.json` contains live API keys and must never be committed or pushed to any remote. Keep secrets local and use `config.example.json` for shareable configuration changes.**
>
> **CRITICAL AI AGENT RULE: USE NATIVE EDIT TOOLS**
> **NEVER use terminal scripts (`node -e`, `echo`, `Set-Content`, etc.) to create or modify files. ALWAYS use native VS Code tools (`replace_string_in_file`, `create_file`) to prevent encoding bugs and preserve undo history.**

> **v2.0 Model-Centric Architecture - COMPLETE**
>
> The refactor from provider-centric to model-centric architecture is complete.
> The gateway is now stateless with explicit capability declarations.

## Current Status

- **v2.0**: Model-centric architecture (COMPLETE)
- **v1.x**: Provider-centric architecture (archived docs in `docs/_Archive/`)
- **Task-based query system**: Named tasks with preset model + parameters, client overrides apply (COMPLETE)
- **Chat cancellation**: WebSocket `chat.cancel` and HTTP disconnect abort propagation are implemented for fetch-based chat adapters
- **Implicit max token budget**: Omitted `max_tokens` values are resolved centrally from remaining context and surfaced in response context metadata
- **WebSocket context telemetry**: `chat.progress` context stats are kept authoritative during streaming and `chat.done` now carries final context metadata
- **Kimi K2.5 output budgeting**: The gateway sends both `max_tokens` and `max_completion_tokens` for Kimi chat completions
- **OpenAI-spec tool use**: Function calling (`tools`, `tool_choice`, `parallel_tool_calls`) works across REST and WebSocket with adapter-specific format conversion (COMPLETE)
- **OpenAI Responses API**: `POST /v1/responses` proxies to the `responses` adapter with streaming and non-streaming support
- **Video generation**: `POST /v1/videos/generations` routes to Gemini (Veo) and OpenAI adapters
- **Admin endpoints**: `/config` (GET) and `/config/store` (POST) for config management with hot-reload (localhost-only)
- **Queryable logs**: `GET /logs` with filters for level, type, sessionId, limit
- **WebSocket binary media**: `media.start/stop` for binary file uploads with `gateway-media://` URL injection into chat messages
- **WebSocket audio**: `audio.start/stop/vad` for binary audio stream negotiation (framework in place)
- **Embedding batching**: Automatic batching of embedding requests via `EmbeddingBatcher`

## Documentation

- [REST API](../documentation/api_rest.md) - Standard HTTP interface
- [WebSocket API](../documentation/api_websocket.md) - JSON-RPC real-time interface

## Overall Design & Architecture

The LLM Gateway is a lightweight, high-performance Node.js API that sits between client applications and disparate LLM providers (OpenAI, Anthropic, Gemini, local models, etc.), normalizing these endpoints into a single unified interface.

*Note: The WebAdmin graphical frontend has been split into its own independent project.*

### Core Components
- **Adapters (`src/adapters/`)**: Normalizes upstream LLM APIs into a unified standard interface.
- **Core (`src/core/`)**: Handles model routing, ticket registries for async jobs, and circuit breaking for resilience.
- **Context Management (`src/context/`)**: Performs token estimation for context telemetry only. The gateway is stateless; context compaction is a client concern.
- **Dual Interfaces**:
  - **HTTP/REST (`src/routes/`, `src/streaming/`)**: Standard OpenAI-compatible endpoints with Server-Sent Events (SSE).
  - **WebSocket (`src/websocket/`)**: Low-latency, bi-directional JSON-RPC protocol supporting active chat cancellation, binary media/audio, and multiplexing.
- **Utilities (`src/utils/`)**: Image fetching (SSRF-safe), media processing client, response normalization, thinking tag stripping, file-based media storage.

### Model-Centric Design (v2.0)

Each model is independently configured with:
- **Type**: chat, embedding, image, audio, video
- **Adapter**: Protocol handler (gemini, openai, ollama, responses, etc.)
- **Capabilities**: Explicit declaration (contextWindow, vision, etc.)
- **Endpoint/Auth**: Per-model configuration
- **Disabled**: Set `disabled: true` to temporarily disable a model without removing it from config

### Disabling Models

Temporarily disable any model by adding `disabled: true`:

```json
"gpt-4": {
  "type": "chat",
  "adapter": "openai",
  "endpoint": "...",
  "disabled": true
}
```

Disabled models:
- Are excluded from `/v1/models` listing
- Return `403 Forbidden` if requested directly
- Can be re-enabled by removing the flag or setting `disabled: false`

### Available Adapters

| Adapter | Description | Supported Types |
|---------|-------------|-----------------|
| `openai` | Standard OpenAI Chat Completions API | chat, embedding, image, audio, video |
| `responses` | OpenAI Responses API (newer format) | chat |
| `anthropic` | Anthropic Claude API | chat |
| `gemini` | Google Gemini API | chat, embedding, image, audio, video |
| `kimi` | Moonshot Kimi API (native HTTP) | chat |
| `kimi-cli` | Moonshot Kimi CLI (subprocess) | chat |
| `ollama` | Ollama local API | chat, embedding |
| `lmstudio` | LM Studio API | chat, embedding |
| `dashscope` | Alibaba DashScope (TTS only) | audio |
| `alibaba` | Alibaba Cloud AI (unified) | chat, embedding, image, audio |
| `llamacpp` | llama.cpp local server | chat, embedding |

> **Note:** `dashscope` is a dedicated TTS-only adapter. For unified Alibaba Cloud support (chat + embeddings + TTS + image), use the `alibaba` adapter. `kimi-cli` uses a CLI subprocess and is registered but not the primary Kimi path — use `kimi` for HTTP-based Kimi integration.

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Chat completions (streaming SSE, async via `X-Async`) |
| POST | `/v1/responses` | OpenAI Responses API proxy |
| POST | `/v1/embeddings` | Embedding generation |
| POST | `/v1/images/generations` | Image generation |
| POST | `/v1/audio/speech` | Text-to-speech synthesis |
| POST | `/v1/videos/generations` | Video generation |
| GET | `/v1/models` | List available models (supports `?type=` filter) |
| GET | `/v1/tasks` | List available tasks |
| GET | `/v1/tasks/:id` | Poll async ticket status |
| GET | `/v1/tasks/:id/stream` | SSE stream for async ticket |
| GET | `/v1/system/events` | SSE stream for system lifecycle events |
| GET | `/health` | Health check with circuit breaker stats |
| GET | `/help` | API documentation rendered as HTML |
| GET | `/config` | Get raw config (localhost-only) |
| POST | `/config/store` | Save config + hot-reload (localhost-only) |
| GET | `/logs` | Queryable structured log access |

### WebSocket Methods

| Method | Description |
|--------|-------------|
| `session.initialize` | Authentication via access_key |
| `chat.create` | Initiate chat completion stream |
| `chat.append` | Append message to buffer and generate |
| `chat.cancel` | Cancel active generation |
| `settings.update` | Acknowledge settings change |
| `audio.start` | Start audio stream (format negotiation) |
| `audio.stop` | Stop audio stream |
| `audio.vad` | Voice Activity Detection event |
| `media.start` | Start binary media upload stream |
| `media.stop` | Complete media upload stream |
| `ping` | Returns pong with timestamp |

### Stateless Operation

- Client sends full message history with each request
- No server-side session management
- No `X-Session-Id` header
- Context management is the client's responsibility

### Task-Based Query System

Tasks provide semantic routing with preset parameters defined in `config.json`:

```json
"tasks": {
  "query": {
    "model": "openai-chat",
    "description": "General query and conversation",
    "maxTokens": 4096,
    "temperature": 0.7
  }
}
```

**Request:** `"task": "query"` in the request body (HTTP or WebSocket).

**Merge behavior:** `finalRequest = { ...taskDefaults, ...clientRequestBody }` — client params always win.

**Supported task parameters:** `model` (required), `description`, `systemPrompt`, `maxTokens`, `temperature`, `topP`, `topK`, `stripThinking`, `noThinking`, `responseFormat`, `extraBody`, `presencePenalty`, `frequencyPenalty`, `seed`, `stop`, `max_tokens`, `strip_thinking`, `no_thinking`, `top_p`, `top_k`, `presence_penalty`, `frequency_penalty`, `response_format`, `extra_body`, `enable_thinking`, `chat_template_kwargs`.

**System prompt handling:** Task `systemPrompt` is prepended before all existing messages, regardless of role.

**Task validation:** Task models must reference existing models. Unknown task names return `400`.

**Endpoints:**
- `GET /v1/tasks` — list available tasks
- `POST /v1/chat/completions` — accepts `task` param
- `POST /v1/embeddings` — accepts `task` param
- `POST /v1/images/generations` — accepts `task` param
- `POST /v1/audio/speech` — accepts `task` param
- `POST /v1/videos/generations` — accepts `task` param
- WebSocket `chat.create` / `chat.append` — accepts `task` in params

## Development Notes

### Active Chat Behavior

- WebSocket clients cancel generation with `chat.cancel` and `params.request_id`
- HTTP chat requests abort upstream generation when the client disconnects
- Response context now exposes `resolved_max_tokens` and `max_tokens_source`
- WebSocket `chat.done` includes final `context` metadata for client persistence
- Kimi chat requests sanitize prior assistant thinking traces before estimation and upstream dispatch
- Kimi native token counting uses dedicated Moonshot tokenizer endpoints when available and falls back to estimator logic if token estimation is unavailable
- `kimi-cli` adapter remains registered but is not the primary Kimi path — use the `kimi` adapter for HTTP-based integration
- Qwen models support `enable_thinking` toggle via `extraBody.chat_template_kwargs` — set to `false` to disable verbose reasoning

### Thinking Control (Per-Request)

The gateway supports disabling/enabling model reasoning per-request from both REST and WebSocket endpoints. All sources resolve to a single normalized `enable_thinking` field before reaching adapters.

**Resolution priority** (highest wins):
1. Request-level `enable_thinking` (REST body or WS params)
2. Request-level `extra_body.chat_template_kwargs.enable_thinking` (REST)
3. Request-level `chat_template_kwargs.enable_thinking` (REST)
4. Config-level `extraBody.chat_template_kwargs.enable_thinking` (model config)
5. Adapter default (no param sent — model decides)

**REST usage (OpenAI-compliant):**
```json
{ "extra_body": { "chat_template_kwargs": { "enable_thinking": false } } }
```

**REST usage (gateway convenience):**
```json
{ "enable_thinking": false }
```

**WebSocket usage (gateway-native):**
```json
{ "enable_thinking": false }
```

**Config default:**
```json
"my-model": { "extraBody": { "chat_template_kwargs": { "enable_thinking": false } } }
```

**Adapter translation:**

| Adapter | `enable_thinking` becomes |
|---------|--------------------------|
| `openai` | `chat_template_kwargs.enable_thinking` |
| `llamacpp` | `chat_template_kwargs.enable_thinking` |
| `lmstudio` | `chat_template_kwargs.enable_thinking` |
| `alibaba` | `enable_thinking` (top-level) |

**Pipeline:** `_buildChatOptions` calls `_resolveThinking()` which merges all sources into a single `enable_thinking` value. Each adapter translates this to its native format. Config `extraBody` is applied first, then `extra_body`, then `enable_thinking` overrides both.

### Local Inference (llama.cpp)

The gateway routes to external llama.cpp servers via the `llamacpp` adapter. Local inference configuration (`localInference`) in model config is passed to the server endpoint — the gateway does not manage `llama-server.exe` processes itself.

**Config Example:**
```json
"llama-chat": {
  "adapter": "llamacpp",
  "endpoint": "http://localhost:4080",
  "capabilities": { "contextWindow": 64000, "vision": true },
  "localInference": {
    "enabled": true,
    "modelPath": "D:/models/chat-model.gguf",
    "mmproj": "D:/models/mmproj-f16.gguf",
    "contextSize": 64000,
    "gpuLayers": 99,
    "flashAttention": true,
    "mlock": true
  }
}
```

**Files:**
- `src/adapters/llamacpp.js` - OpenAI-compatible API adapter

### Media Processing

- **Image Fetcher** (`src/utils/image-fetcher.js`): Fetches remote images with SSRF protection and size limits
- **Media Processor Client** (`src/utils/media-client.js`): External image processing service client for resize/transcode/quality optimization. Opt-in via `request.image_processing` options.
- **Media Storage** (`src/utils/storage.js`): File-based media storage with TTL-based eviction
- **WebSocket Binary Media**: `media.start/stop` protocol with `gateway-media://` URL scheme for injecting uploaded files into chat messages

### Logging

Each gateway startup creates a new timestamped log file in `logs/`:
- Format: `YYYY-MM-DD-HH-MM-SS-sessionId.log`
- Latest logs are always at the top of the `logs/` folder (sorted by name)
- The most recent gateway log is the file in `logs/` with the newest timestamp prefix; with an ascending name sort it will be the last `gw-*.log` file for the latest date/time
- Logs are written to files only; the central logger no longer mirrors entries to stdio
- Logs older than 1 day are pruned automatically on startup (override with `LOG_RETENTION_DAYS`)
- Logs are excluded from git via `.gitignore`
- Access logs programmatically via `GET /logs` with query filters (`level`, `type`, `sessionId`, `limit`)

---

## Coding Ethics & Philosophy

**This codebase follows deterministic, rigorous engineering principles.**

### Core Principles

1. **Design Failures Away**
   - Prevention produces more reliable systems than handling
   - Every eliminated failure condition is a state that can never occur
   - If a function can fail on valid input, the design is wrong — fix the function

2. **No Defensive Programming for Internal Code**
   - Silent fallbacks and swallowed exceptions hide bugs, they don't make systems safer
   - Defensive patterns are for external systems only (network, user input, third-party APIs)
   - For internal code: verify preconditions, fail fast, make failures visible

3. **Disposal is Mandatory and Verifiable**
   - Every resource created must have a proven disposal path
   - Creation without verified disposal is an incomplete design

4. **Block Until Truth**
   - UI reflects actual state, not assumed state
   - During transitions, inputs are blocked so race conditions are structurally impossible
   - A UI that says "done" before the operation completes isn't responsive — it's dishonest

5. **Single Responsibility**
   - Can you describe what the function does without "and" or "or"?
   - This is not about length — a long function performing one coherent transformation is fine
   - Two operations that must always happen together are one responsibility

6. **Code is Primary Truth**
   - Source code is the only artifact that actually runs
   - Comments drift. Code changes; comments are forgotten
   - Comment only what the code cannot say: regulatory requirements, historical context, non-obvious consequences

7. **Measure Before Optimizing**
   - Write clear code. Measure with realistic data. Optimize proven bottlenecks.
   - If you cannot measure the difference, the difference does not matter

8. **Abstraction From Evidence**
   - First use case: write it directly
   - Second: copy and modify
   - Third: now the pattern is visible — abstract
   - Wrong abstraction is harder to remove than no abstraction

### Additional Rules

- **Prefer self-explanatory code over comments** — JSDoc is a parallel type system that competes with the actual one
- **Functional purity** — isolate impurity at boundaries, keep core pure
- **Explicit dependencies** — hidden dependencies are welded to their environment
- **Immutability by default** — mutation creates temporal dependencies
- **Composition over inheritance** — inheritance creates tight coupling

### Universal Truths vs Inherited Patterns

| Universal (Keep) | Inherited (Question) |
|------------------|----------------------|
| Separation of concerns | Silent fallbacks for "safety" |
| Explicit contracts | Optimistic assumptions |
| Validating user input | Defensive programming for code you control |
| Network timeouts | Error handlers that hide design gaps |

**Before applying any pattern, ask:** *"Does this make the system more reliable, more performant, or both? Or am I emulating a limitation I don't have?"*

### Anti-Patterns to Avoid

- **The God Object** — single point of failure
- **The Manager Class** — vague name hiding multiple responsibilities
- **The Utility Dump** — unrelated functions creating false coupling
- **The Abstract Factory Factory** — speculative flexibility with certain complexity
- **Stringly-Typed Code** — moves error detection to production
- **Documentation That Lies** — false confidence is dangerous
- **Type Theater** — treating annotations as proof

### The Mindset Shift

| From | To |
|------|----|
| "What if something goes wrong?" | "How do I design this so it cannot go wrong?" |
| "I'll handle the error case" | "I'll eliminate the error case" |
| "Good enough for now" | "Correct or not at all" |

### Where These Apply

**Applies to:** System design, resource management, state machines, UI architecture, internal code

**Does not apply to:** Third-party code, external APIs, user input, hardware — these boundaries need defensive patterns

### Verification Questions

Before committing to an implementation:
1. Can this function be understood by reading it once?
2. Are dependencies visible where they matter?
3. Does data flow clearly from input to output?
4. Can invalid states be constructed?
5. Have I measured the performance concern?
6. Is this abstraction based on actual patterns or anticipation?
7. Does any comment explain something the code could express?

---

## Reference

Full philosophy document: See `docs/_Archive/` for the complete "Deterministic Mind" manifesto (from previous projects, same principles apply here).
