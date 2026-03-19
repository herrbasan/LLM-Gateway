# LLM Gateway

> **🚨 CRITICAL AI AGENT RULE: DO NOT KILL NODE PROCESSES 🚨**
> **NEVER use `taskkill`, `Stop-Process`, `kill`, or any other commands to stop or manage Node processes. This machine runs multiple unrelated background node services. Let the user handle ALL server restarts and process management. NEVER start or stop node processes yourself.**

> **✅ v2.0 Model-Centric Architecture - COMPLETE**
> 
> The refactor from provider-centric to model-centric architecture is complete.
> The gateway is now stateless with explicit capability declarations.

## Current Status

- **v2.0**: Model-centric architecture (✅ **COMPLETE**)
- **v1.x**: Provider-centric architecture (archived docs in `docs/_Archive/`)
- **Chat cancellation**: WebSocket `chat.cancel` and HTTP disconnect abort propagation are implemented for fetch-based chat adapters
- **Implicit max token budget**: Omitted `max_tokens` values are resolved centrally from remaining context and surfaced in response context metadata

## Documentation

- [API Documentation](./docs/api_documentation.md) - Current API (v2.0)
- [Refactor Plan](./docs/REFACTOR_PLAN_MODEL_CENTRIC.md) - Architecture specification & completion status
- [Archived Documentation](./docs/_Archive/) - Historical docs from v1.x

## Architecture Overview

### Model-Centric Design (v2.0)

Each model is independently configured with:
- **Type**: chat, embedding, image, audio
- **Adapter**: Protocol handler (gemini, openai, ollama, etc.)
- **Capabilities**: Explicit declaration (contextWindow, vision, etc.)
- **Endpoint/Auth**: Per-model configuration

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
- `kimi-cli` is no longer part of the active chat path; do not rely on it for current behavior documentation

### Logging

Each gateway startup creates a new timestamped log file in `logs/`:
- Format: `YYYYMMDD-HHMMSS-sessionId.log`
- Latest logs are always at the top of the `logs/` folder (sorted by name)
- Logs are excluded from git via `.gitignore`

### WebAdmin Updates Needed

The WebAdmin interface (`WebAdmin/` directory) needs updates to align with v2.0:

1. **Remove Sessions Page**
   - Delete `public/pages/test-sessions.html`
   - Remove "Sessions" from navigation in `public/js/main.js`
   - Remove session API routes from `routes/api.js`

2. **Update Dashboard**
   - Change "Providers" section to "Models" section
   - Display model list from `/v1/models` endpoint
   - Update health display to show adapter states

3. **Update Providers Page**
   - Rename to "Models"
   - Show flat model list instead of provider-grouped view
   - Display model capabilities directly from config

4. **Update Config Validation**
   - Change from `providers` to `models` section validation
   - Update example configs in Settings editor

5. **Update Footer Version**
   - Change from "v1.0" to "v2.0" in `public/index.html`

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
