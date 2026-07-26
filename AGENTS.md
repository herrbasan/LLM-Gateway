# LLM Gateway

> **CRITICAL AI AGENT RULE: DO NOT KILL NODE PROCESSES**
> **NEVER use `taskkill`, `Stop-Process`, `kill`, or any other commands to stop or manage Node processes. This machine runs multiple unrelated background node services. Let the user handle ALL server restarts and process management. NEVER start or stop node processes yourself.**
>
> **CRITICAL AI AGENT RULE: DO NOT RESTART THE GATEWAY**
> **The LLM Gateway is a central part of the user's workflow — it proxies all LLM traffic for active development sessions. NEVER start, stop, or restart the gateway yourself. The user will restart it at opportune moments after you've made changes. Announce when changes require a restart, but wait for the user to do it.**
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
- **Per-model `maxOutputTokens`**: Omitted `max_tokens` values fall back to `capabilities.maxOutputTokens` declared in each model config. Required for Anthropic-adapter upstreams (Kimi, DeepSeek, MiniMax). OpenAI-adapter upstreams omit the field and use their own default.
- **WebSocket context telemetry**: `chat.progress` context stats are kept authoritative during streaming and `chat.done` now carries final context metadata
- **Kimi K2.5 output budgeting**: The gateway sends both `max_tokens` and `max_completion_tokens` for Kimi chat completions
- **OpenAI-spec tool use**: Function calling (`tools`, `tool_choice`, `parallel_tool_calls`) works across REST and WebSocket with adapter-specific format conversion (COMPLETE)
- **OpenAI Responses API**: `POST /v1/responses` proxies to the `responses` adapter with streaming and non-streaming support
- **Video generation**: `POST /v1/videos/generations` routes to Gemini (Veo) and OpenAI adapters
- **Admin endpoints**: `/config` (GET) and `/config/store` (POST) for config management with hot-reload (localhost-only)
- **Queryable logs**: `GET /logs` with filters for level, type, sessionId, limit
- **WebSocket binary media**: `media.start/stop` for binary file uploads with `gateway-media://` URL injection into chat messages
- **WebSocket audio**: `audio.start/stop/vad` for binary audio stream negotiation (framework in place)

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
- **Adapter**: Protocol handler (gemini, openai, alibaba, responses, etc.)
- **Capabilities**: Explicit declaration (contextWindow, vision, thinking, excludeParams, etc.)
- **Endpoint/Auth**: Per-model configuration
- **Disabled**: Set `disabled: true` to temporarily disable a model without removing it from config

**Capability flags:**
- `thinking: "chat_template_kwargs"` — Model supports `chat_template_kwargs.enable_thinking` (llama.cpp/Qwen). Without this, the thinking param is silently dropped for OpenAI-adapter models.
- `excludeParams: ["temperature", "top_p", ...]` — Parameters to strip from the upstream payload. Used for reasoning models that reject sampling params.

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

| Adapter | Description | Supported Types | Notes |
|---------|-------------|-----------------|-------|
| `openai` | Standard OpenAI Chat Completions API | chat, embedding, image, audio, video | Omits `max_tokens` when client omits it; upstream decides default |
| `responses` | OpenAI Responses API (newer format) | chat | — |
| `anthropic` | Anthropic Claude API | chat | Requires `max_tokens`; falls back to `capabilities.maxOutputTokens` if client omits it |
| `gemini` | Google Gemini API | chat, embedding, image, audio, video | — |
| `kimi` | Moonshot Kimi API (native HTTP) | chat | — |
| `alibaba` | Alibaba Cloud AI (unified) | chat, embedding, image, audio | — |
| `llamacpp` | llama.cpp local server | chat, embedding | — |

> **Note:** The `alibaba` adapter handles all Alibaba/DashScope functionality (chat, embeddings, TTS, images). For Kimi, use the `kimi` adapter (native HTTP).

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
    "temperature": 0.7,
    "default": true
  },
  "embed": {
    "model": "gemini-embedding",
    "fallback": "llama-embed",
    "description": "Text embedding generation",
    "default": true
  }
}
```

**Request:** `"task": "query"` in the request body (HTTP or WebSocket).

**Merge behavior:** `finalRequest = { ...taskDefaults, ...clientRequestBody }` — client params always win.

**Supported task parameters:** `model` (required), `description`, `systemPrompt`, `maxTokens`, `temperature`, `topP`, `topK`, `noThinking`, `responseFormat`, `extraBody`, `presencePenalty`, `frequencyPenalty`, `seed`, `stop`, `max_tokens`, `no_thinking`, `top_p`, `top_k`, `presence_penalty`, `frequency_penalty`, `response_format`, `extra_body`, `enable_thinking`, `chat_template_kwargs`.

**System prompt handling:** Task `systemPrompt` is prepended before all existing messages, regardless of role.

**Task validation:** Task models must reference existing models. Unknown task names return `400`.

**Default tasks:** When a request has no `model` and no `task`, the router finds the task with `"default": true` and uses its model. Each request type (chat, embedding, image, audio) should have exactly one default task.

**Fallback models (embeddings ONLY):** Tasks of type `embedding` may declare a `"fallback"` model. This is the ONLY case fallback is permitted, because a local and cloud embedding model with identical weights and dimensions produce interchangeable vectors — the swap is invisible to correctness. When the primary embedding model fails, the gateway:
1. Records the failure with a timestamp
2. Routes subsequent embedding requests to the fallback for the cooldown period (`fallbackCooldownMinutes`, default 1 min). A fallback-served success does NOT clear the failure state — the cooldown runs to expiry.
3. After cooldown expires, tries the primary again
4. On a primary success, clears the failure state
5. If the primary fails again, re-enters fallback mode

**Chat (and image/audio/video) have NO fallback — by design.** Silently swapping the model mid-conversation would mean the user is suddenly talking to a different (and possibly inferior) model without realizing it. That is unacceptable. A dead chat model must fail loudly with a clear error, so the user sees it and switches deliberately. Do not add chat fallback.

```json
"embed": {
  "model": "local-embed",
  "fallback": "cloud-embed",
  "fallbackCooldownMinutes": 60,
  "default": true
}
```

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
- OpenAI-spec responses do not include gateway-specific `context` metadata; usage `prompt_tokens` is still overridden with the gateway's context estimate
- WebSocket `chat.done` includes final `context` metadata for client persistence
- Kimi chat requests sanitize prior assistant thinking traces before estimation and upstream dispatch
- Kimi native token counting uses dedicated Moonshot tokenizer endpoints when available and falls back to estimator logic if token estimation is unavailable
- Qwen models support `enable_thinking` toggle via `extraBody.chat_template_kwargs` — set to `false` to disable verbose reasoning

### Max Output Tokens

The gateway does not synthesize output token budgets. For each model:

- If the client sends `max_tokens` / `max_completion_tokens`, it is forwarded unchanged.
- If omitted and the model declares `capabilities.maxOutputTokens`, that value is sent upstream.
- If omitted and no `maxOutputTokens` is declared, the field is omitted (OpenAI-adapter upstreams provide their own default; Anthropic-adapter upstreams will reject the request).

This means Anthropic-adapter models (Kimi, DeepSeek, MiniMax) **must** declare `capabilities.maxOutputTokens` in `config.json`.

### GLM Models — OpenAI Adapter (z.ai Context Caching)

**2026-06-27**: All GLM chat models (`glm5-chat`, `glm5-turbo-chat`, `glm5v-turbo-chat`) switched from `anthropic` to `openai` adapter to leverage z.ai's automatic context caching (~50% cost reduction on repeated context).

z.ai's context caching is:
- **Automatic** — no client-side `cache_control` config needed; the platform detects repeated content
- **Endpoint-specific** — only available on the OpenAI-compatible `/api/paas/v4` endpoint, NOT the Anthropic protocol endpoint
- **Transparent billing** — cached token count appears in `usage.prompt_tokens_details.cached_tokens`

**Old Anthropic endpoint** (for reference if we need to switch back):
```
endpoint: "https://api.z.ai/api/anthropic"
adapterModel variants: "glm-5.2" / "glm-5-turbo" / "glm-5v-turbo"
```

**Current OpenAI endpoint**:
```
endpoint: "https://api.z.ai/api/paas/v4"
adapterModel variants: "glm-5" / "glm-5-turbo" / "glm-5v-turbo"
```

> **Trade-off**: The Anthropic adapter had rich thinking control and native tool-call format conversion. The openai adapter uses standard OpenAI tool format. If thinking control or Anthropic-native tools become critical, switch back by restoring the old endpoint and adapter + changing adapterModel back to `glm-5.2`.

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

| Adapter | `enable_thinking` becomes | Gate |
|---------|--------------------------|------|
| `openai` | `chat_template_kwargs.enable_thinking` | Only if `capabilities.thinking === "chat_template_kwargs"` |
| `llamacpp` | `chat_template_kwargs.enable_thinking` | Always (llama.cpp native param) |
| `alibaba` | `enable_thinking` (top-level) | Always |
| `gemini` | `generationConfig.thinkingConfig` | Always |
| `anthropic` | `thinking` block | Always |
| `responses` | `reasoning.effort` | Always |

**Capability gate:** The `openai` adapter serves many incompatible upstream APIs (Grok, OpenRouter, Kimi, etc.) that reject `chat_template_kwargs`. Only models that declare `capabilities.thinking: "chat_template_kwargs"` receive the parameter. Without the declaration, `enable_thinking` is silently dropped for that model.

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

**FAILURE IS CHEAPER THAN CONFUSION.** A crash with a clear stack trace costs 30 seconds. A silent fallback producing wrong numbers costs hours of debugging and real money in API credits burned. In development, correctness is the only performance metric that matters.

### Forbidden Patterns

These patterns have repeatedly caused hours of wasted debugging and real financial cost. They are banned in this codebase:

1. **The `||` Fallback on Falsy-Valid Values**
   - `x || defaultValue` silently replaces `0`, `false`, `''`, and `[]` with garbage
   - Use `??` when `null`/`undefined` are the only invalid states
   - If a value must be a specific type, validate it — don't silently replace it

2. **Mock Data, Defaults, and Placeholders**
   - Never invent numbers when you don't know them (`contextWindow || 8192`)
   - Never substitute plausible values for missing data
   - If the data isn't there, the request is invalid — reject it
   - A model without a declared `contextWindow` is a broken config, not an opportunity to guess
   - **CRITICAL: When you encounter a fallback, default, or placeholder — REMOVE IT.**
     Do not "fix" it by raising the number. Do not "improve" it with a better guess.
     Trace back to where the value SHOULD come from and make that source authoritative.
     Every `|| 4096` or `?? 8192` you leave behind will silently corrupt data for the next person.

3. **try/catch That Swallows Errors**
   - `try { ... } catch { /* ignore */ }` is a crime scene
   - If an operation can fail, either it shouldn't be called, or the failure should propagate
   - The ONLY valid catch is at system boundaries (network, user input, third-party APIs)
   - Every silent catch you write today will cost someone a day of debugging tomorrow

4. **Defensive `?.` Chains into Nothing**
   - `a?.b?.c ?? defaultValue` is three lies in a trenchcoat
   - If `a.b.c` is required, access it directly and let it crash if missing
   - Optional chaining is for optional data — not for avoiding design work

5. **Silent Type Coercion**
   - `false || 'backup'` → `'backup'` is a bug factory
   - `0 || 1000000` → `1000000` cost us real debugging hours today
   - Zero is a valid number. Empty string is a valid string. Treat them as such.

### Core Principles

0. **Fail Fast, Fail Loud**
   - A crash with a stack trace is a gift — it tells you exactly what's wrong
   - A silent fallback is a thief — it steals hours of your life
   - Development code should explode on invalid state, not gracefully degrade
   - This costs real money: wrong context numbers → wrong API calls → wasted tokens

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
- **The Silent Fallback** — `x || default` where `x` can legitimately be `0`, `false`, or `''`. Silently replaces real data with lies.
- **The Guessing Game** — `contextWindow || 8192` or `maxOutput || contextWindow`. If you don't know the number, the config is broken — reject it.
- **The Empty Catch** — `try { } catch { }` or `try { } catch { /* ignore */ }`. Every swallowed error is a future debugging session you're stealing from yourself.

### The Mindset Shift

| From | To |
|------|----|
| "What if something goes wrong?" | "How do I design this so it cannot go wrong?" |
| "I'll handle the error case" | "I'll eliminate the error case" |
| "Good enough for now" | "Correct or not at all" |
| "I don't have the number, I'll guess" | "The config is broken — reject it" |
| "What should this default to?" | "Why would the value ever be absent?" |

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
