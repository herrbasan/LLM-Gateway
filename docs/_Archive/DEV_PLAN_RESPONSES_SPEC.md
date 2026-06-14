# Development Plan: Spec-Compliant `/v1/responses` Endpoint

> **Status:** Core normalization works for chat-adapter upstreams. The `responses`-adapter passthrough path and several spec features remain.
> **Last updated:** 2026-06-09

---

## 0. Goal & Core Distinction

**Goal:** Offer clients a **spec-compliant OpenAI Responses API endpoint** (`POST /v1/responses`). A client that speaks the Responses spec must get spec-compliant responses back — *for every model the gateway can route to*, regardless of which upstream provider serves it.

This is a **normalization** task, consistent with the gateway's purpose: present one unified, standards-compliant interface to clients while hiding provider differences upstream.

### Two unrelated things are both named "responses"

These must be kept strictly separate throughout this plan:

| Term | What it is | Concern |
|------|-----------|---------|
| **`/v1/responses` endpoint** | The **client-facing** surface. Its contract: accept a Responses-spec request, return a Responses-spec response. | Normalization (this plan's goal) |
| **`responses` adapter** | An **upstream** protocol handler that talks to a provider which natively speaks `/v1/responses` (i.e. OpenAI). It is just *one* of many possible upstreams. | Transport to one provider |

The endpoint is the product. The adapter is an implementation detail behind it. **A client never selects the adapter** — it picks a model (or task), and the gateway routes to whatever upstream serves that model, normalizing the wire format in both directions.

### The contract, stated precisely

> **Whatever model is routed, `POST /v1/responses` emits Responses-spec output. The *direction* of normalization depends only on what the upstream natively speaks.**

| Client endpoint | Upstream adapter | Normalization the gateway performs |
|-----------------|------------------|------------------------------------|
| `/v1/responses` | `responses` (OpenAI native) | **None** — forward upstream Responses events/JSON through raw |
| `/v1/responses` | chat adapters (gemini, anthropic, kimi, llamacpp, …) | **Chat → Responses** (already implemented) |
| `/v1/chat/completions` | `responses` (OpenAI native) | **Responses → Chat** (`transformStreamingEvent` in the adapter) |
| `/v1/chat/completions` | chat adapters | **None** — passthrough |

Every gap and phase below is scoped to a specific cell of this matrix. The most common mistake — and the source of the current streaming bug — is conflating the top-right cell (the goal) with the bottom-left cell (a Chat-Completions concern that lives in the adapter).

---

## 1. Current State Assessment

The normalization for **chat-adapter upstreams** is already built and wired in `model-router.js#routeResponse` (via `convertStreamToResponseEvents` / `chatCompletionsToResponse` in `src/utils/response-format.js`). The remaining work is the `responses`-adapter passthrough path and spec features.

### What Already Works

| Feature | Matrix cell | Status | Notes |
|---------|-------------|--------|-------|
| `/v1/responses` ← chat adapter (non-streaming) | row 2 | ✅ Works | `chatCompletionsToResponse` builds a spec `response` object |
| `/v1/responses` ← chat adapter (streaming) | row 2 | ✅ Works | `convertStreamToResponseEvents` emits spec events (`response.created` → `response.completed`) |
| `input` array (text + image) | both | ✅ Works | Passed through if present; converted from `messages` if absent |
| `reasoning` / `enable_thinking` | both | ✅ Works | `enable_thinking` → `reasoning.effort` (`low`/`medium`) |
| `tools` (custom functions) | both | ✅ Works | Passed through |
| `text.format` (JSON schema) | both | ✅ Works | Maps from `response_format` |
| `max_output_tokens` | both | ✅ Works | Resolved from `max_tokens` or config `maxTokens` |
| Model routing via tasks | both | ✅ Works | `task` param supported |
| Request abort propagation | both | ✅ Works | HTTP disconnect cancels upstream |

### What's Missing / Broken

| Gap | Matrix cell | Severity | Description |
|-----|-------------|----------|-------------|
| `responses`-native path emits Chat-shaped output | row 1 | **High** | When `/v1/responses` routes to the `responses` adapter, the adapter's `transformStreamingEvent` converts upstream Responses events *into Chat Completions chunks* (`choices[0].delta`). The route then writes those to the client — violating the endpoint contract. The one path that should be the most spec-pure is the least. **Root fix:** the `responses` adapter must forward raw Responses events when the caller is `/v1/responses`. |
| SSE `[DONE]` termination | row 1 & 2 | **High** | Route handler unconditionally emits `data: [DONE]\n\n`. Responses spec has no `[DONE]`; the stream ends on `response.completed`/`failed`/`incomplete`. |
| Built-in tools | row 1 | **High** | `web_search_preview`, `file_search`, `computer_use_preview` only valid when upstream is the `responses` adapter. Must be passed through there and **rejected** for chat adapters. |
| `input` with file refs | both | **Medium** | `input` can contain `input_file` (`file_id`) and `input_document` items. Conversion path only handles text/image. (Passthrough of client-supplied `input` already works.) |
| WebSocket `/v1/responses` equivalent | both | **Medium** | No `response.create` / `response.append` WebSocket methods. Same contract as the HTTP endpoint must apply. |
| `tool_choice` for built-ins | row 1 | **Medium** | `{"type": "web_search_preview"}` not validated/gated to the `responses` adapter. |
| `include` parameter | row 1 | **Low** | `include: ["file_search_call.results"]` passed through but not surfaced in row-2 normalization. |
| `store` / `metadata` | both | **Low** | Passed through; gateway is stateless and does not act on them. |
| `truncation` strategy | both | **Low** | `truncation: "auto"`/`"disabled"` passed through but not implemented by gateway. |

---

## 2. Architectural Decisions

### Decision 1: The endpoint contract is normalization, not passthrough

`/v1/responses` **always** returns Responses-spec output. It is not a thin proxy to the `responses` adapter — it is a normalizing surface over *any* routed model. The gateway decides the normalization direction from the upstream adapter (see the matrix in §0), never from a client-supplied mode flag.

Concretely:

- **Chat-adapter upstream** → gateway converts Chat Completions → Responses spec (`chatCompletionsToResponse` / `convertStreamToResponseEvents`). *Already implemented.*
- **`responses`-adapter upstream** → gateway forwards the upstream's native Responses events/JSON **raw**. *This is the path to fix:* the adapter currently mistranslates them into Chat chunks (see Phase 1).

> The inverse translation in the `responses` adapter (`transformStreamingEvent`, Responses → Chat) is **not** part of the `/v1/responses` contract. It belongs to a different matrix cell: a `responses`-adapter model accessed via `/v1/chat/completions`. Do not invoke it on the `/v1/responses` path.

### Decision 2: `gateway_format` is an optional override, not a core mode

A `/v1/responses` caller may *opt down* into Chat-Completions framing (e.g. for BYOK/Copilot tooling that only parses Chat chunks) via an explicit `gateway_format: "chat_completions"`. This is a **convenience override layered on top of the normalized default** — not one of two co-equal modes. The default is, and remains, spec-compliant Responses output. (See Phase 5; low priority.)

### Decision 3: Stateless by Design

The gateway is explicitly stateless. `previous_response_id` is passed through to the upstream, but the gateway does not store conversation state or maintain a `response_id` → `input` mapping. Clients relying on server-side state must target a stateful upstream (e.g. OpenAI) directly. **Do not implement server-side state storage** — it violates the gateway's architecture.

### Decision 4: Built-in tools are upstream-specific

Built-in tools (`web_search_preview`, `file_search`, `computer_use_preview`, `code_interpreter`, `image_generation`) are OpenAI-native. They are valid **only** when the routed model uses the `responses` adapter. When a chat-adapter model is routed through `/v1/responses`, built-in tools must be **rejected with a 400** (not silently stripped — fail loud). Custom `function` tools pass through to any adapter that supports them.

---

## 3. Implementation Phases

> Phases are ordered by how directly they serve the endpoint contract (§0). Phase 1 fixes the one path that currently violates it.

### Phase 1: Make the `responses`-adapter path spec-compliant (Immediate)

**Files:** `src/adapters/responses.js`, `src/routes/responses.js`, `src/core/model-router.js`

This is the **High**-severity root fix. Two coupled defects break row 1 of the matrix (`/v1/responses` ← `responses` adapter):

**1a. Adapter mistranslates upstream events.**
`streamComplete` runs every upstream event through `transformStreamingEvent`, which converts spec events into Chat Completions chunks (`choices[0].delta`). On the `/v1/responses` path this is wrong — the client asked for Responses spec and the upstream already speaks it. The adapter must **forward the raw upstream events untouched** for this path.

`transformStreamingEvent` is not deleted — it stays for the *other* matrix cell (`responses` adapter accessed via `/v1/chat/completions`). The two paths must select different behavior. Options:
- Add a streaming method (or flag) on the adapter that yields raw events, and have `_routeResponseNative` call it; keep `transformStreamingEvent` for the chat-completions entry point.
- The route already distinguishes `_format: 'responses-native'`; ensure that path carries raw spec events end-to-end.

**1b. Route emits `[DONE]`.**
`src/routes/responses.js` unconditionally writes `data: [DONE]\n\n`. The Responses spec has no `[DONE]`; the stream ends on `response.completed`/`failed`/`incomplete`. Remove it for spec output; emit it only under the `gateway_format: "chat_completions"` override (Phase 5). The heartbeat (`: heartbeat\n\n`) is valid SSE comment syntax — keep it.

**Acceptance:** A streamed `/v1/responses` request to a `responses`-adapter model produces only spec events (`response.created` → `response.completed`), byte-for-byte forwarded from upstream, with no `[DONE]` and no `choices[0].delta` shapes.

---

### Phase 2: Built-in Tool Support

**Files:** `src/adapters/responses.js`, `src/core/model-router.js`, `src/routes/responses.js`

#### 2a. Tool Definition Passthrough + Gating

Responses API built-in tools have a different shape:

```json
{
  "tools": [
    { "type": "web_search_preview" },
    { "type": "file_search", "vector_store_ids": ["vs_xxx"], "max_num_results": 10 },
    { "type": "computer_use_preview", "display_width": 1024, "display_height": 768 }
  ]
}
```

Per Decision 4, built-in tools are valid only for `responses`-adapter models.

**Implementation:**

1. In `buildPayload()`, keep passthrough for `tools` and `tool_choice` (including built-in `tool_choice` like `{"type": "web_search_preview"}`).
2. In the router, **before dispatch**: if any built-in tool type is present and the resolved adapter is not `responses`, throw `400` (fail loud — do not strip).
3. Document which tools work with which adapters.

#### 2b. Tool Output Event Streaming

Built-in tools emit additional event types:

```
response.web_search_call.in_progress / .searching / .completed
response.file_search_call.in_progress / .completed
response.computer_call.in_progress / .completed
```

On the `/v1/responses` path these are already-correct spec events and are **forwarded raw** by the Phase 1 fix — no mapping needed. Under the Phase 5 `chat_completions` override, drop these lifecycle events (no Chat Completions equivalent).

---

### Phase 3: Rich `input` Array Support

**File:** `src/adapters/responses.js`

The Responses API `input` array supports more than text:

```json
{
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Analyze this" },
        { "type": "input_image", "image_url": "https://..." },
        { "type": "input_file", "file_id": "file-xxx" },
        { "type": "input_document", "filename": "report.pdf", "file_id": "file-yyy" }
      ]
    }
  ]
}
```

Current `convertMessagesToInput()` only handles `text` and `image_url`.

**Implementation:**

1. If the client sends `input` directly, pass it through without conversion.
2. If converting from `messages`, handle `image_url` (already done) and add support for file references if the message contains them.
3. File fetching is out of scope — the gateway does not fetch arbitrary file URLs. If a client sends a `file_id`, it must be valid at the upstream.

**Note:** File handling (`input_file`, `input_document`) requires the upstream provider to have file storage. The gateway is a pass-through here.

---

### Phase 4: WebSocket Responses Surface

**Files:** `src/websocket/handlers/`, `src/websocket/protocol.js`

The WebSocket surface must honor the **same contract** as the HTTP endpoint (§0): `response.*` methods accept Responses-spec params and emit Responses-spec events, normalizing across upstreams exactly like `/v1/responses`. The matrix from §0 applies unchanged — only the transport differs.

Currently, WebSocket only supports:
- `chat.create` / `chat.append` → Chat Completions format
- `chat.cancel`

**Add:**
- `response.create` — initiate a Responses request (spec in, spec out)
- `response.append` — append to a stateful response (requires `previous_response_id`; upstream-managed state only — see Decision 3)
- `response.cancel` — cancel an in-flight response

**Format:** Same JSON-RPC structure as chat methods, but using Responses API parameters:

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "response.create",
  "params": {
    "model": "gpt-chat",
    "input": "Hello",
    "stream": true,
    "tools": [{ "type": "web_search_preview" }]
  }
}
```

**Events emitted:**
- `response.output_text.delta` → passthrough from upstream
- `response.completed` → passthrough
- `response.error` → mapped to `error_response`

**Implementation approach:**

Option A: Create a new `ResponseHandler` class parallel to `ChatHandler`.
Option B: Extend `ChatHandler` to support both formats.

**Recommendation:** Option A — separate handler, separate file. Less coupling, clearer separation of concerns. Reuse `RequestContext` and `RequestState` for cancellation.

---

### Phase 5: `gateway_format` Override (Optional)

**Files:** `src/routes/responses.js`, `src/websocket/handlers/response.js`

A **layered convenience override** (Decision 2) for callers that hit `/v1/responses` but can only parse Chat-Completions framing (e.g. BYOK/Copilot tooling). The spec-compliant default is unchanged; this only adds an opt-down path.

```json
{
  "model": "gpt-chat",
  "input": "Hello",
  "stream": true,
  "gateway_format": "chat_completions"
}
```

| `gateway_format` | Non-streaming | Streaming |
|-----------------|---------------|-----------|
| *(unset, default)* | Responses-spec JSON | Responses-spec SSE events |
| `chat_completions` | Translated to `chat.completion` | Translated to `chat.completion.chunk` |

**Implementation:**

1. Add `gateway_format` to the request schema (optional; absent = spec output).
2. In `routeResponse()`, when `gateway_format === 'chat_completions'`, skip the Chat→Responses normalization for chat adapters, and apply the `responses` adapter's `transformStreamingEvent` (Responses→Chat) for `responses`-adapter upstreams.
3. Emit `data: [DONE]\n\n` only under this override.

---

### Phase 6: Output Item & Content Part Tracking — **mostly done**

**Files:** `src/utils/response-format.js` (implemented), `src/adapters/responses.js`

The Chat→Responses normalization that builds the structured `output` array already exists and is wired into `routeResponse`:
- Non-streaming: `chatCompletionsToResponse()` emits `output` with `message` and `function_call` items.
- Streaming: `convertStreamToResponseEvents()` emits `response.output_item.added` / `response.content_part.added` / `...done` and a final `response.completed` carrying the assembled `output`.

**Remaining (small):**
- Surface `reasoning` output items when the upstream chat response carries reasoning content (currently `reasoning` is emitted as null/empty).
- For `responses`-adapter upstreams, the structured `output` is forwarded raw (Phase 1) — no work needed.

This section was previously marked "deferred"; that is **stale**. The core converters exist and are tested in `tests/openai-compat.test.js`.

---

## 4. Testing Plan

### Unit Tests

| Test | File |
|------|------|
| `/v1/responses` ← responses adapter forwards raw spec events (no `choices[0].delta`) | `tests/responses.routes.test.js` (new) |
| SSE stream ends without `[DONE]` on spec output | `tests/responses.routes.test.js` (new) |
| Built-in tools rejected with 400 for chat adapters | `tests/router.v2.test.js` |
| `gateway_format: chat_completions` opt-down triggers translation | `tests/responses.routes.test.js` |
| `input` array passed through untouched | `tests/adapters.v2.test.js` |
| `previous_response_id` passed through | `tests/adapters.v2.test.js` |
| WebSocket `response.create` initiates spec stream | `tests/websocket.responses.test.js` (new) |
| WebSocket `response.cancel` aborts upstream | `tests/websocket.responses.test.js` (new) |
| Chat→Responses converter emits full event sequence | `tests/openai-compat.test.js` (exists) |

### Integration Tests

| Test | Setup |
|------|-------|
| Full flow: `POST /v1/responses` with `web_search_preview` | Requires OpenAI API key |
| Full flow: Streaming with built-in tool events | Requires OpenAI API key |
| WebSocket `response.create` with `input` array | Requires running gateway + WS client |

---

## 5. API Documentation Updates

**Files:** `documentation/api_rest.md`, `documentation/api_websocket.md`

Add sections:

1. **`POST /v1/responses`** — full parameter reference
2. **Built-in tools** — which tools are supported, how to use them
3. **`gateway_format`** — selecting output format
4. **WebSocket Responses API** — `response.create`, `response.append`, `response.cancel`
5. **Event reference** — all Responses API event types and their gateway behavior

---

## 6. Open Questions

1. **Should the gateway support `previous_response_id` for non-OpenAI models?**
   - No. It's an OpenAI-specific stateful feature. If a client wants stateful conversations with Gemini, they should use `chat.create` / `chat.append` WebSocket or send full history.

2. **Should built-in tools be available via WebSocket?**
   - Yes, if the upstream model supports them. The gateway is a transparent proxy.

3. **What happens if a client sends `input` and `messages` together?**
   - Current behavior: `input` takes precedence. Document this.

4. **Should the gateway validate `file_id` references?**
   - No. File IDs are upstream-scoped. The gateway does not manage file storage.

5. **`reasoning.summary` events — should they be stripped or passed through?**
   - On `/v1/responses`, pass through (spec output). Under the `gateway_format: "chat_completions"` override, drop them (no equivalent field).

---

## 7. Summary & Priorities

| Phase | Priority | Effort | Impact |
|-------|----------|--------|--------|
| 1: `responses`-adapter raw forwarding + drop `[DONE]` | **P0** | 1–2 hrs | Makes row-1 of the matrix spec-compliant; without it `/v1/responses` lies for OpenAI-backed models |
| 2a: Built-in tool passthrough + 400 gating | **P1** | 2 hrs | Enables search, code interpreter, computer use; fails loud for chat adapters |
| 2b: Tool output events | **P1** | included in P1 | Forwarded raw by Phase 1; nothing extra for spec output |
| 3: Rich `input` array (file/document) | **P2** | 3 hrs | File and document input support |
| 4: WebSocket Responses surface | **P2** | 1 day | Same contract over WebSocket |
| 5: `gateway_format` override | **P3** | 4 hrs | Opt-down for Chat-Completions-only clients |
| 6: Output item tracking | **mostly done** | small | Core converters exist; only reasoning items remain |

---

## Appendix A: Responses API vs. Chat Completions — Gateway Mapping

| Responses API Field | Chat Completions Equivalent | Gateway Behavior |
|--------------------|----------------------------|------------------|
| `input` | `messages` | Converted if `input` absent; passed through if present |
| `previous_response_id` | None (stateful) | Passed through to upstream |
| `text.format` | `response_format` | Mapped from `response_format.json_schema` |
| `reasoning.effort` | None | Mapped from `enable_thinking` (`low`/`medium`) |
| `tools` (function) | `tools` | Passed through |
| `tools` (built-in) | None | Only for `responses` adapter |
| `tool_choice` | `tool_choice` | Passed through |
| `max_output_tokens` | `max_tokens` | Resolved from `max_tokens` or config |
| `store` | None | Passed through |
| `metadata` | None | Passed through |
| `include` | None | Passed through |
| `truncation` | None | Passed through |

## Appendix B: Event Type Mapping

"Spec output" = the default `/v1/responses` behavior. "`chat_completions` override" = the optional `gateway_format` opt-down (Phase 5). For `responses`-adapter upstreams, spec output = raw upstream events (Phase 1); the right column applies only when translating Responses→Chat for the override.

| Responses Event | Spec output (default) | `chat_completions` override |
|--------------------|-------------|----------------------|
| `response.created` | Emit / forward | Drop |
| `response.in_progress` | Emit / forward | Drop |
| `response.output_text.delta` | Emit / forward | `delta.content` |
| `response.output_item.added` | Emit / forward | Drop |
| `response.content_part.added` | Emit / forward | Drop |
| `response.function_call_arguments.delta` | Emit / forward | `delta.function_call.arguments` |
| `response.reasoning_text.delta` | Emit / forward | `delta.reasoning_content` |
| `response.reasoning_summary_text.delta` | Emit / forward | Drop |
| `response.refusal.delta` | Emit / forward | `delta.refusal` |
| `response.completed` / `response.done` | Emit / forward | `finish_reason: stop` + usage |
| `response.failed` | Emit / forward | Error chunk |
| Built-in tool events | Forward raw | Drop |
