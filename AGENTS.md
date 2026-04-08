# LLM Gateway

> **🚨 CRITICAL AI AGENT RULE: DO NOT KILL NODE PROCESSES 🚨**
> **NEVER use `taskkill`, `Stop-Process`, `kill`, or any other commands to stop or manage Node processes. This machine runs multiple unrelated background node services. Let the user handle ALL server restarts and process management. NEVER start or stop node processes yourself.**
>
> **🚨 CRITICAL SECURITY RULE: DO NOT PUSH `config.json` TO REMOTES 🚨**
> **`config.json` contains live API keys and must never be committed or pushed to any remote. Keep secrets local and use `config.example.json` for shareable configuration changes.**
>
> **🚨 CRITICAL AI AGENT RULE: USE NATIVE EDIT TOOLS 🚨**
> **NEVER use terminal scripts (`node -e`, `echo`, `Set-Content`, etc.) to create or modify files. ALWAYS use native VS Code tools (`replace_string_in_file`, `create_file`) to prevent encoding bugs and preserve undo history.**

> **✅ v2.0 Model-Centric Architecture - COMPLETE**
> 
> The refactor from provider-centric to model-centric architecture is complete.
> The gateway is now stateless with explicit capability declarations.

## Current Status

- **v2.0**: Model-centric architecture (✅ **COMPLETE**)
- **v1.x**: Provider-centric architecture (archived docs in `docs/_Archive/`)
- **Chat cancellation**: WebSocket `chat.cancel` and HTTP disconnect abort propagation are implemented for fetch-based chat adapters
- **Implicit max token budget**: Omitted `max_tokens` values are resolved centrally from remaining context and surfaced in response context metadata
- **WebSocket context telemetry**: `chat.progress` context stats are kept authoritative during streaming and `chat.done` now carries final context metadata
- **Kimi K2.5 output budgeting**: The gateway sends both `max_tokens` and `max_completion_tokens` for Kimi chat completions

## Documentation

- [REST API](../docs/api_rest.md) - Standard HTTP interface
- [WebSocket API](../docs/api_websocket.md) - JSON-RPC real-time interface

## Overall Design & Architecture

The LLM Gateway is a lightweight, high-performance Node.js API that sits between client applications and disparate LLM providers (OpenAI, Anthropic, Gemini, local models, etc.), normalizing these endpoints into a single unified interface.

*Note: The WebAdmin graphical frontend has been split into its own independent project.*

### Core Components
- **Adapters (`src/adapters/`)**: Normalizes upstream LLM APIs into a unified standard interface.
- **Core (`src/core/`)**: Handles model routing, ticket registries for async jobs, and circuit breaking for resilience.
- **Context Management (`src/context/`)**: Performs token estimation and automatic context compaction for oversized prompt requests.
- **Dual Interfaces**:
  - **HTTP/REST (`src/routes/`, `src/streaming/`)**: Standard OpenAI-compatible endpoints with Server-Sent Events (SSE).
  - **WebSocket (`src/websocket/`)**: Low-latency, bi-directional JSON-RPC protocol supporting active chat cancellation and multiplexing.

### Model-Centric Design (v2.0)

Each model is independently configured with:
- **Type**: chat, embedding, image, audio
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
| `openai` | Standard OpenAI Chat Completions API | chat, embedding, image, audio |
| `responses` | OpenAI Responses API (newer format) | chat |
| `anthropic` | Anthropic Claude API | chat |
| `gemini` | Google Gemini API | chat, embedding, image, audio |
| `kimi` | Moonshot Kimi API (native) | chat |
| `ollama` | Ollama local API | chat, embedding |
| `lmstudio` | LM Studio API | chat, embedding |
| `dashscope` | Alibaba DashScope | chat |
| `alibaba` | Alibaba Cloud AI | chat |
| `llamacpp` | llama.cpp local server | chat, embedding |

### Local Inference (llama.cpp)

The gateway can auto-manage local llama.cpp servers for running GGUF models locally.

**Setup:**
1. Download/build `llama-server.exe` and place in `inference/` folder
2. Add required DLLs for CUDA support: `cudart64_13.dll`, `cublas64_13.dll`, `cublasLt64_13.dll`
3. Configure model in `config.json` with `localInference.enabled: true`

**Config Example:**
```json
"llama-local": {
  "adapter": "llamacpp",
  "endpoint": "http://localhost:12346",
  "capabilities": { 
    "contextWindow": 8192,
    "structuredOutput": true
  },
  "localInference": {
    "enabled": true,
    "modelPath": "/path/to/your/model.gguf",
    "contextSize": 8192,
    "gpuLayers": 99,
    "flashAttention": "on",
    "mlock": true,
    "contBatching": true
  }
}
```

**Auto-Management:**
- Gateway starts `llama-server.exe` on first request
- Server runs on configured port
- Process terminates when gateway shuts down
- All stderr output piped through gateway logger

**Path Handling:**
- Paths containing `#` are automatically escaped (`#` → `\#`)
- This prevents `#` from being interpreted as a comment by llama-server

**Performance Tuning:**
| Option | Effect |
|--------|--------|
| `contextSize` | Lower = faster (try 4096-8192 for chat) |
| `flashAttention: "on"` | Essential for large contexts |
| `mlock: true` | Prevents model swapping to disk |
| `cacheTypeK/V: "q8_0"` | 8-bit KV cache saves VRAM |

**Multi-Model Support:**
Configure multiple models on different ports:
```json
"llama-chat": { "endpoint": "http://localhost:12346", ... },
"llama-embed": { "endpoint": "http://localhost:12347", "embedding": true, ... }
```
Each model runs its own `llama-server.exe` process. VRAM is shared across models.

**Keep-Alive (Always-Loaded):**
By default, servers stay running indefinitely (no TTL). To prevent any idle cleanup:
```json
"noClearIdle": true,
"sleepIdleSeconds": -1
```
This matches LMStudio behavior - models stay in VRAM permanently.

**Files:**
- `src/core/inference-manager.js` - Process lifecycle management
- `src/adapters/llamacpp.js` - OpenAI-compatible API adapter
- `inference/llama-server-reference.md` - Full command reference

### Stateless Operation

- Client sends full message history with each request
- No server-side session management
- No `X-Session-Id` header
- Automatic context compaction when needed

## Development Notes

### Active Chat Behavior

- WebSocket clients cancel generation with `chat.cancel` and `params.request_id`
- HTTP chat requests abort upstream generation when the client disconnects
- Response context now exposes `resolved_max_tokens` and `max_tokens_source`
- WebSocket `chat.done` includes final `context` metadata for client persistence
- Kimi chat requests sanitize prior assistant thinking traces before estimation and upstream dispatch
- Kimi native token counting uses dedicated Moonshot tokenizer endpoints when available and falls back to estimator logic if token estimation is unavailable
- `kimi-cli` is no longer part of the active chat path; do not rely on it for current behavior documentation
- Qwen models support `enable_thinking` toggle via `extraBody.chat_template_kwargs` - set to `false` to disable verbose reasoning
- Local inference servers (llama.cpp) pipe stderr through the gateway logger for debugging startup issues

### Logging

Each gateway startup creates a new timestamped log file in `logs/`:
- Format: `YYYY-MM-DD-HH-MM-SS-sessionId.log`
- Latest logs are always at the top of the `logs/` folder (sorted by name)
- The most recent gateway log is the file in `logs/` with the newest timestamp prefix; with an ascending name sort it will be the last `gw-*.log` file for the latest date/time
- Logs are written to files only; the central logger no longer mirrors entries to stdio
- Logs older than 1 day are pruned automatically on startup (override with `LOG_RETENTION_DAYS`)
- Logs are excluded from git via `.gitignore`

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

Full philosophy document: See `../docs/_Archive/` for the complete "Deterministic Mind" manifesto (from previous projects, same principles apply here).
