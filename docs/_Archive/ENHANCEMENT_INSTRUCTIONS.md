# LLM Gateway — Enhancement Instructions

> **Context:** This document contains all verified defects and missing spec features in the current implementation, ordered by severity. The canonical specifications are `docs/LLM_GATEWAY_SPEC.md` and `docs/DEV_PLAN.md`. Reference them for exact API shapes, field names, and behavioral contracts.

---

## Critical Bugs (Fix First)

### 1. Compaction Trigger Uses OR Instead of AND

**File:** `src/core/router.js` (~line 107)

**Current (wrong):**
```javascript
if (estimatedTokens > availableTokens || estimatedTokens > minTokens) {
```

**Correct:**
```javascript
if (estimatedTokens >= minTokens && estimatedTokens > availableTokens) {
```

Both conditions must be true. `minTokensToCompact` is a minimum threshold to avoid wasting compute on small prompts — it does NOT independently trigger compaction. The current code runs compaction on every prompt over 2000 tokens even if it fits in the context window.

### 2. Error Codes Don't Map to HTTP Status

**File:** `src/core/router.js`, `src/server.js`

The router throws string errors like `"[Router] 413 Payload Too Large: ..."` and `"[Router] 404 Session Not Found: ..."` but the global error handler in `server.js` doesn't parse these — everything returns HTTP 500.

**Fix:** Either:
- Set `err.status` on thrown errors in the router (e.g., `const err = new Error("..."); err.status = 413; throw err;`)
- Or parse error messages in the global handler to extract status codes

Ensure these mappings work:
| Error pattern | HTTP Status |
|---|---|
| `413 Payload Too Large` | 413 |
| `404 Session Not Found` | 404 |
| `404 No adapter found` | 404 |
| `does not support structured output` | 400 |
| `does not support embeddings` | 400 |
| `Circuit is OPEN` | 503 |
| `429` / queue full | 429 |
| Provider connection failures | 502 |

---

## Missing Spec Features

### 3. Per-Request `context_strategy` Override

**Spec reference:** LLM_GATEWAY_SPEC.md → "Context Handling Strategies (Per-Request)", DEV_PLAN.md → Phase 6

Clients should be able to pass `context_strategy` in the request body:
```json
{
  "model": "auto",
  "messages": [...],
  "context_strategy": {
    "mode": "rolling",
    "preserve_recent": 4,
    "chunk_size": 8000,
    "max_tokens": 28000
  }
}
```

**Currently:** The router only reads strategy from session or global config. The request body `context_strategy` field is completely ignored.

**Fix:** In `src/core/router.js`, read `payload.context_strategy` and use it as the primary strategy source, falling back to session strategy → global config.

### 4. Context Window Reporting in Responses

**Spec reference:** LLM_GATEWAY_SPEC.md → Response 200

Every chat completion response must include:
```json
{
  "choices": [...],
  "usage": {...},
  "context": {
    "window_size": 32768,
    "used_tokens": 175,
    "available_tokens": 32593,
    "strategy_applied": false
  }
}
```

**Currently:** The chat route passes through whatever the adapter returns. No `context` field is added.

**Fix:** In `src/routes/chat.js` (for non-streaming) and `src/streaming/sse.js` (as a final `event: context.status` SSE event), inject context window metadata after completion. The router should return context metadata alongside the result.

### 5. Async Ticket System (`X-Async: true`)

**Spec reference:** LLM_GATEWAY_SPEC.md → "Ticket-Based API", DEV_PLAN.md → Phase 3 checklist

When client sends `X-Async: true` header and the prompt needs compaction, return:
```json
HTTP 202
{
  "object": "chat.completion.task",
  "ticket": "tkt_xyz789",
  "status": "accepted",
  "estimated_chunks": 3,
  "stream_url": "/v1/tasks/tkt_xyz789/stream"
}
```

**Required new files/components:**
- `src/core/ticket-registry.js` — In-memory Map storing ticket state (`accepted`, `processing`, `complete`, `failed`) and results
- `src/routes/tasks.js` — `GET /v1/tasks/:id` (poll status) and `GET /v1/tasks/:id/stream` (SSE progress)
- Router logic: check `x-async` header; if true and compaction needed, create ticket + run compaction in background, return 202 immediately

### 6. Compaction Progress Events in Streaming

**Spec reference:** LLM_GATEWAY_SPEC.md → "Large Prompt Streaming"

When streaming a request that triggers compaction, emit SSE events before token streaming:
```
event: compaction.start
data: {"estimated_chunks":3}

event: compaction.progress
data: {"chunk":1,"total":3}

event: compaction.complete
data: {"original_tokens":45000,"final_tokens":2800}

data: {"choices":[{"delta":{"content":"The"}}]}
...
data: [DONE]
```

**Currently:** Compaction runs synchronously in the router before streaming starts. No events are emitted.

**Fix:** The compaction path in the router (or a new streaming-aware compaction wrapper) needs to yield progress events that the `StreamHandler` emits before forwarding the token generator. Consider making the context strategies accept a progress callback.

### 7. Session API Gaps

**Spec reference:** DEV_PLAN.md → Phase 6 → "Creating a Session", "Session API Endpoints"

**Missing features:**

a) `POST /v1/sessions` should accept the full `context_strategy` object:
```json
{
  "context_strategy": {
    "mode": "truncate",
    "preserve_recent": 4,
    "compression_threshold": 0.8
  },
  "ttl_minutes": 60
}
```
Currently only accepts `strategy` (string) and `preserveSystemPrompt`.

b) `POST /v1/sessions/:id/compress` — Force compression endpoint. Not implemented. Should accept:
```json
{ "strategy": "rolling", "preserve_recent": 6 }
```

c) Session response should include context stats:
```json
{
  "session": {
    "id": "sess_abc123",
    "message_count": 5,
    "context": {
      "window_size": 32768,
      "used_tokens": 2450,
      "available_tokens": 30318,
      "compression_count": 0,
      "strategy": "truncate"
    }
  }
}
```

### 8. Tiered Token Estimation — Missing tiktoken

**Spec reference:** DEV_PLAN.md → Phase 4 → "Tiered token estimation"

The spec defines three tiers:
1. Provider native API (e.g., Gemini `countTokens`) ✅ implemented
2. tiktoken with appropriate encoding (e.g., `cl100k_base`) ❌ missing
3. Character heuristic (`length * fallbackRatio`) ✅ implemented

**Fix:** Add `tiktoken` (or `js-tiktoken`) as a dependency. In `src/context/estimator.js`, after the provider API check fails, try tiktoken before falling back to the heuristic. Choose encoding based on provider/model (e.g., `cl100k_base` for OpenAI-compatible models, `o200k_base` for newer ones).

---

## Consistency Issues

### 9. `provider` Field Missing from Some Adapter Responses

**Spec reference:** LLM_GATEWAY_SPEC.md → "Response 200"

The spec shows `"provider": "lmstudio"` in completion responses. Currently:
- LM Studio: returns raw upstream response (no `provider` field)
- Ollama: adds `provider: "ollama"` ✅
- Gemini: adds `provider: "gemini"` ✅
- OpenAI: returns raw upstream response (no `provider` field)

**Fix:** For LM Studio and OpenAI adapters, inject `provider: adapter.name` into the response object in the `predict()` method. Or add it at the route handler level after receiving the result.

### 10. Field Naming Convention Not Enforced (camelCase vs snake_case)

**Spec reference:** LLM_GATEWAY_SPEC.md → "Conventions"

Convention: camelCase internally, snake_case in API payloads, X-Kebab-Case for headers.

**Current violations:**
- Session store uses `created_at` (snake) and `last_accessed` (snake) — these are correct for API output but the internal object mixes conventions
- `context_strategy` in request body is snake_case (correct for API)
- Config uses camelCase (`preserveLastN`) — correct for internal
- No translation layer exists at the route boundary

**Fix:** Add a small utility or inline transformation in route handlers that converts internal camelCase session/context objects to snake_case before sending as JSON response. Apply the inverse when reading `context_strategy` from request bodies.

### 11. Heartbeat Interval Hardcoded

**File:** `src/streaming/sse.js`

The heartbeat interval is hardcoded to `15000` instead of reading `config.compaction.heartbeatIntervalMs`.

**Fix:** Pass config (or just the interval value) into `StreamHandler` constructor and use it in `setInterval`.

---

## Test Gaps

### 12. Missing Test Coverage

Add tests for:

| Area | Test File | What to Test |
|---|---|---|
| Rolling compression | `tests/context.test.js` | Mock adapter, verify chained summaries produce correct output |
| Streaming / SSE | `tests/streaming.test.js` (new) | Verify SSE headers, `data:` format, `[DONE]` termination, heartbeat comments |
| Session + chat flow | `tests/sessions.test.js` (new) | Create session → send message → verify history accumulates → send follow-up → verify context |
| Compaction trigger (AND logic) | `tests/context.test.js` | Verify compaction does NOT fire when tokens < minTokensToCompact even if > availableTokens. Verify it does NOT fire when tokens > minTokensToCompact but fits in context window |
| Error code mapping | `tests/server.test.js` | Verify 413 for oversized + mode=none, 404 for missing session, 400 for structured output to non-capable provider |
| Per-request context_strategy | `tests/context.test.js` | Send request with `context_strategy: { mode: "none" }` to a prompt that exceeds context → verify 413. Send with `mode: "truncate"` → verify truncation applies |

---

## Implementation Priority Order

1. **Fix compaction trigger** (Bug #1) — this is actively causing unnecessary compaction
2. **Fix error code mapping** (Bug #2) — clients get wrong HTTP status codes
3. **Add `provider` field consistency** (#9) — quick fix, high visibility
4. **Per-request `context_strategy`** (#3) — core spec feature
5. **Context window reporting** (#4) — clients need this to understand what happened
6. **Compaction progress events** (#6) — completes streaming story
7. **Session API gaps** (#7) — complete the session contract
8. **Ticket system** (#5) — most complex, do last
9. **tiktoken integration** (#8) — nice-to-have accuracy improvement
10. **Field naming + heartbeat** (#10, #11) — polish
11. **Test coverage** (#12) — expand alongside each fix

---

## Development Guidelines (Reminders)

- **No comments** — code must be self-evident
- **Fail-fast** — no defensive try/catch without recovery strategy
- **Functional preference** — pure functions where possible
- **No build step** — vanilla JavaScript, native Node.js modules
- **camelCase internal, snake_case API** — translate at route boundary
- **Reliability > Performance > Human Readability**

---

## Reference Files

- `docs/LLM_GATEWAY_SPEC.md` — Canonical API specification
- `docs/DEV_PLAN.md` — Canonical development plan with phase definitions
- `docs/PROJECT_DOCUMENTATION.md` — Current state documentation
- `config.example.json` — Config structure reference
