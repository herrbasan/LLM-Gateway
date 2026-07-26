# Codebase Review — Performance, Reliability & Maxims Alignment

**Date:** 2026-07-24
**Scope:** Full sweep of `src/`, `tests/`, `package.json`, `config.example.json` against AGENTS.md and the Deterministic Mind maxims.
**Method:** Four parallel subsystem reviews (adapters, core, REST/streaming, utils/tests/deps), every top finding manually verified against source before inclusion. Priorities cross-checked with an independent model review.
**Purpose of the gateway:** Reliable, OpenAI-spec-compliant proxy in front of heterogeneous LLM providers. Primary consumers: VS Code Copilot (BYOK) and the custom chat app, both over REST + SSE.

---

## 1. Executive Summary

The gateway is structurally sound: clean adapter factory, stateless routing, correct SSE backpressure and abort propagation on the sync hot path, honest startup validation. The 2026-07-23 SSE context fix is correct in mechanism.

The problems are concentrated in three places:

1. **Fail-loud violations at the worst possible spots.** The anthropic stream loop swallows upstream mid-stream errors; the fallback tracker's cooldown is defeated after one request; several adapters silently fabricate data (fake model lists, `{}` tool arguments, NaN budgets) instead of rejecting broken state.
2. **Reliability gaps in the shared HTTP layer.** No timeout anywhere, a retry wrapper that double-spends tokens and hides rate limits from the circuit breaker, and circuit breakers scoped per-adapter-protocol so one bad upstream fast-fails every model sharing that adapter.
3. **Spec-compliance drift in the responses adapter** — the weakest OpenAI-spec citizen — and a non-spec `reasoning_content` injection applied to *all* upstreams by the openai adapter.

The WebSocket subsystem is cleanly severable (§7) and its removal is the single biggest readability win available.

---

## 2. Top Findings — Fix Immediately (P0)

### 2.1 `anthropic.js` — silent catch swallows upstream stream errors
**File:** `src/adapters/anthropic.js`, stream loop (~line 536 throw, ~line 703 catch).

The per-line dispatch is wrapped in one `try { JSON.parse ... yield ... } catch { /* Ignore parse errors */ }`. The same catch that ignores malformed JSON also swallows the **deliberately thrown** upstream error event:

```js
if (event.type === 'error') {
    logger.error('Anthropic stream emitted error event', ...);
    throw new Error(`Upstream API Stream Error: ...`);   // thrown here...
}
// ... 160 lines of yield handlers ...
} catch {
    // Ignore parse errors                                  // ...caught and discarded here
}
```

**Impact:** A mid-stream provider error (overloaded, rate-limited mid-generation, credit exhaustion) produces a silently truncated stream. Copilot then throws its generic "Response contained no choices" and the actual upstream error — which *was logged* — never reaches the client or the circuit breaker. This defeats the fail-loud error handling that was intentionally added and is the single worst pattern in the codebase per the maxims.
**Fix shape:** Catch only the `JSON.parse` line; let everything else propagate. One-line structural change.

### 2.2 Circuit breakers are per-adapter-protocol, not per-model
**File:** `src/core/adapters.js:46-66`.

Six breakers per adapter *type*: `openai:chat`, `openai:stream`, etc. Every model on the openai adapter (Grok, OpenRouter, z.ai GLM, Kimi-via-openai, llama.cpp wrapper) shares them. One flaky upstream trips the breaker → **all other models on that adapter fast-fail with 503 for 30s**. Additionally, HALF-OPEN is not half-open: when the timeout expires, every concurrent request flips to HALF-OPEN and probes simultaneously (no single-probe limit), so a stampede re-trips the breaker.

**Impact:** The resilience mechanism creates correlated outages across unrelated providers — the opposite of its purpose. Breaker state in `/health` reports per-adapter while the error message says "provider".
**Fix shape:** Key breakers per model (or model+endpoint) instead of per adapter type; allow exactly one probe in HALF-OPEN. Medium effort — breaker instances move from `createAdapters()` to per-request lookup keyed by model id.

### 2.3 No upstream hang detection anywhere
**Files:** `src/utils/http.js` (no timeout), `src/streaming/sse.js` (no read-deadline), all adapters.

Fetch has no `AbortSignal.timeout`; the SSE loop has no inter-chunk deadline. A provider that accepts the request and never sends a byte leaves the gateway streaming 15s heartbeats to the client **indefinitely**. The circuit breaker only trips on errors — a hang produces none.

**Impact:** Highest reliability gap on the Copilot hot path. Observed behavior with some OpenRouter/Kimi upstreams. The client hangs; the slot burns; nothing recovers.
**Fix shape:** Inter-chunk watchdog (reset per chunk/read, abort controller on expiry), NOT a blanket stream timeout — reasoning models legitimately pause >60s between chunks. A first-byte deadline on non-streaming requests (`AbortSignal.timeout`) plus a per-read deadline in the stream reader covers both.

### 2.4 `http.js` retry wrapper retries 500s and 429s before adapters see errors
**File:** `src/utils/http.js:26-90`. Verified: **every** adapter call funnels through `request()` (`anthropic.js:389,492,741,790`; openai/responses/gemini likewise).

- Retrying a **500** on a non-idempotent chat POST can silently re-execute a completion that failed mid-generation upstream → duplicate token spend. Real money, per the ethics doc.
- Retrying **429** with up to 3 exponential backoffs delays the rate-limit signal from reaching the circuit breaker and the client; a hard rate limit appears as a ~7s stall then failure instead of an immediate 429.
- `isNetworkError = !error.status || ...` classifies **any** thrown error without a `.status` — including bugs inside the try block — as retriable network errors.
- Consequence of the wrapper throwing on all non-OK: the adapters' own `!res.ok` checks are mostly dead code (only reachable for statuses not in the retry list), and their error-body formatting never runs for 429/5xx.

**Fix shape:** Default `statusCodesToRetry` to connection-level failures only (or `[502, 503, 504]` minus 429/500 for chat POSTs); let the circuit breaker see first failures. Consider retry=0 default for streaming chat.

### 2.5 `buildThinkingConfig` sends NaN budget_tokens
**File:** `src/adapters/anthropic.js:178`.

```js
const budget = Math.max(Math.floor(maxTokens * 0.8), 1024);
// maxTokens === undefined → Math.floor(NaN) → Math.max(NaN, 1024) → NaN
```

`Math.max(NaN, 1024)` is `NaN`. When a client omits `max_tokens` and the model config doesn't declare `capabilities.maxOutputTokens`, thinking-enabled requests carry `budget_tokens: NaN` → serialized as `null` upstream → confusing provider 400. The exact "Guessing Game" class the maxims ban — but worse, it's *silent garbage*, not a guess.
**Fix shape:** Guard `typeof maxTokens === 'number'` before computing; if absent and thinking is requested, either omit `budget_tokens` or throw with a diagnostic naming the model.

### 2.6 Malformed tool-call arguments silently become `{}`
**Files:** `src/adapters/anthropic.js:14`, `src/adapters/gemini.js` (~856).

```js
try { return JSON.parse(args); } catch { return {}; }
```

A truncated/corrupt tool-call arguments string (can happen with mid-stream aborts recorded into history) is forwarded to the upstream tool as **empty input**. The tool executes with wrong arguments; nobody knows.
**Fix shape:** Preserve the raw string (Anthropic accepts strings for input) or throw a diagnostic error identifying the tool call id. Never fabricate `{}`.

### 2.7 Gemini API key leaks into gateway log files
**Files:** `src/adapters/gemini.js` (`?key=` query param on every URL), `src/utils/http.js:74` (`Fetch error against ${url}: ...`).

On any network-level failure, the thrown error message embeds the full URL **including the API key**, and the gateway logs errors with their messages to disk. Keys in `logs/*.log` are a live secret-management incident (and `GET /logs` is API-key-protected but network-reachable, not localhost-only).
**Fix shape:** Scrub `key=` query params in `http.js` error construction (one regex), or move the Gemini key to the `x-goog-api-key` header (supported by the Gemini API). Both is best.

### 2.8 `responses.js` streaming transformer breaks OpenAI spec in three ways
**File:** `src/adapters/responses.js:282-296, 262-273`.

1. **Usage fields untranslated:** `usage: event.response?.usage` passes through `input_tokens`/`output_tokens` — OpenAI chat-completions spec requires `prompt_tokens`/`completion_tokens`.
2. **Usage on the finish chunk:** the anthropic adapter learned (your session memory, 2026-06-06) that Copilot BYOK needs usage in a **separate `choices: []` chunk**. Here usage rides on the `finish_reason` chunk — the same failure class.
3. **Tool calls mapped to legacy `function_call` deltas** instead of `tool_calls[]` — deprecated; Copilot BYOK uses `tool_calls`.

Also: `[DONE]` yields `{ provider: 'openai' }` — a chunk with no `choices`/`object`/`id` (probably dead code, but spec-breaking if hit).
**Fix shape:** Translate usage fields; emit the separate usage-only chunk; map `response.function_call_arguments.*` to `tool_calls[]` deltas. If `/v1/responses` has no active consumer, consider whether the transformer should exist at all (see §6, dead-ish surface).

### 2.9 SSRF via redirect in image-fetcher
**File:** `src/utils/image-fetcher.js:97-113`.

`validateUrl` blocks private IPs on the initial URL, but `fetch` follows redirects by default — a public URL can 302 to `http://169.254.169.254/` (cloud metadata) or any RFC-1918 address. HEAD and GET both follow.
**Fix shape:** `redirect: 'manual'` and validate each `Location` hop (bounded hop count), or resolve and pin DNS before connect.

---

## 3. Fix Soon (P1)

### 3.1 Fallback tracker cooldown defeated; chat has no fallback at all
**Files:** `src/core/model-router.js:509-545`, `src/core/fallback-tracker.js`.

Two distinct bugs:
1. `_executeWithFallback` calls `recordSuccess(taskInfo.id)` on **any** success — including when the fallback served the request (verified: `fallback: effectiveModel !== primaryModel` is computed but not used to gate `recordSuccess`). The failure entry is cleared, so the **next** request retries the dead primary. Documented cooldown behavior holds for exactly one request.
2. `_executeWithFallback` is only wired into embedding/image/audio/video routes. **`routeChatCompletion` has no fallback logic** — a chat task with `fallback` configured silently ignores it. AGENTS.md documents fallback generically; either doc bug or code bug.

**Fix shape:** Pass a `servedByFallback` flag; only `recordSuccess` when the primary succeeded. Wire chat through the same path (streaming complicates this — fallback must trigger before first chunk, which is exactly what the current `fn` call boundary provides).

### 3.2 `adapterModel || '<stale-placeholder>'` — 11 occurrences
**Files:** all four adapters. Placeholders include `gpt-4`, `gpt-4o`, `gemini-pro`, `embedding-001`, `claude-3-opus-20240229`, `dall-e-3`, `tts-1`, `sora-1`.

Several reference **retired model ids**. Missing `adapterModel` is a broken config — per AGENTS.md it must be rejected at startup, not silently aimed at a deprecated model that will 404 or (worse) bill a different model. Config validation should require `adapterModel` per model entry; the fallbacks should be deleted, not improved.

### 3.3 `anthropic.js listModels` — wrong auth + fabricated model list
**File:** `src/adapters/anthropic.js:737-768`. Sends `Authorization: Bearer` to the native Anthropic endpoint (requires `x-api-key` + `anthropic-version`; `buildHeaders` exists but isn't used), gets 401, then `catch { return defaultModels.map(...) }` returns a **hardcoded Claude-3 model list as truth**. Two bugs compounding into invisible failure. `countMessageTokens` (line ~790) similarly degrades to the estimator on any failure with only a warn. Fix: use `buildHeaders`, delete the fake list, fail loud.

### 3.4 `images.js` route — deep copy + log-and-continue corruption
**File:** `src/routes/images.js:18-27`. `JSON.parse(JSON.stringify(result))` doubles peak memory on multi-MB base64 payloads; then detects the `[BINARY_DATA]` placeholder corruption, logs "CRITICAL", and **returns the corrupted payload anyway**. Delete the copy (nothing mutates `result`); if the placeholder check ever fires, throw so the client gets a 500 instead of a broken image.

### 3.5 Async ticket path — no abort, unbounded memory
**Files:** `src/routes/chat.js:44` (`abortController = null` when async), `src/core/ticket-registry.js:60`.

- Ticket-based streaming has **no abort propagation**: if the 202 client never polls and upstream hangs, the fetch runs forever (compounds with 2.3).
- `ticket.events[]` accumulates every chunk for up to 1h TTL — tens of thousands of chunk objects on a long reasoning stream.
**Fix shape:** Give tickets an AbortController cancelled on terminal status + a cap on retained events (replay window, e.g. last N chunks, or none — late-joining SSE clients can be documented as live-only).

### 3.6 `media-client.js` — silent fallback to unprocessed image
**File:** `src/utils/media-client.js:178, 202-204`. On media-processor HTTP error or network failure, returns the **original image** as if processing succeeded. Client believes it sent an optimized image; the model receives a 10MB original. Per maxims: the request should fail (502) — the user attached an image under declared processing options.

### 3.7 `storage.js` media storage — TTL, init, quota
- TTL keyed on `mtime` — any touch (AV scan, backup) resets lifetime. The creation timestamp is already in the filename (`media_${Date.now()}_...`); parse that instead of stat.
- `_initPromise` rejection is cached forever → permanent silent disable after one transient `EACCES`.
- No total-size quota — a burst of 300MB uploads inside one TTL window fills tmpdir.
- Two silent catches (cleanup loop, per-file eviction) — a persistent `EPERM` file is retried forever, unlogged.

### 3.8 nLogger — per-call cost and silent log loss
**File:** `src/nLogger/src/logger.js`. Every log call pays: recursive meta deep-copy → base64 regex on strings ≥100 chars → 5 message regexes → 2× `JSON.stringify`. Runtime log rotation uses **sync fs on the event loop** (blocks in-flight SSE streams). Four empty catches on rotation/prune/stream-open = silent total log loss. Flush timer not `.unref()`'d. Main log writes the **unsanitized** message (multi-line messages corrupt the JSONL that `GET /logs` parses). It's a submodule, so fixes belong upstream — but the gateway depends on the behavior. Highest-value cheap fix: gate sanitization behind a size/complexity pre-check, unref the timer, surface rotation failures.

---

## 4. Cleanup / Refactor (P2)

### 4.1 Token estimation hot path
**File:** `src/core/model-router.js:563-575`. Full-history tiktoken re-estimation on **every** chat request (telemetry-only), with a pointless per-message `await` (the tiktoken path is synchronous; the async signature exists for a dead `countTokens` branch — no adapter implements it). For a 100k-token conversation, ~100k tokens of CPU-bound `encode()` on the event loop per turn. Options: make the tiktoken path synchronous in one pass; cap precise estimation to the last N messages + char-ratio for the rest; or memoize on a prefix hash. Also: `reloadConfig` rebuilds both tiktoken encodings (multi-MB rank tables) on every `/config/store` — hoist module-level; they don't depend on config.

### 4.2 `openai.js` universal `reasoning_content: ""` injection
**File:** `src/adapters/openai.js:452-463`. Mutates client message history for **every** model behind the adapter (Grok, OpenRouter, real OpenAI) — a non-spec field justified by Kimi/DeepSeek needs, plus a full messages-array copy per request. Should be capability-gated (`capabilities.reasoningContent: true`) like every other non-spec behavior in the codebase.

### 4.3 Dead code inventory
| Location | Item |
|---|---|
| `model-router.js:577-584` | `_buildContextPayload` — zero call sites (compaction remnant) |
| `model-router.js:180` | Dead `const message = ...` statement |
| `model-router.js` + `sse.js:121` + ws chat | `strategy_applied: false` hardcoded vestige |
| `estimator.js:39-47` | Dead `countTokens` branch (no adapter implements it) |
| `sse.js:40-45` | `StreamHandler.emitDeltaEvent` — no callers |
| `sse.js:57,61` | `streamOptions` param — accepted, never used |
| `sse.js:90-93` | `seenUpstreamUsage` — tracked, never branched on; comment at 130 lies about conditional injection (injection is unconditional) |
| `chat.js:39-47` | `sessionId` plumbing — contradicts documented stateless architecture; log-only |
| `core/events.js` | `ROUTE_HANDLED` — declared, never emitted |
| `model-registry.js:36` | `getThinkingConfig()` — no consumers; undocumented config surface |
| `websocket/handlers/chat.js.bak` | Stray backup file (dies with WS removal) |
| `health.js:14` | Single-breaker "backwards compatibility" branch — v2 uses plural |
| `package.json` | `test:providers` script → missing file |

### 4.4 Structural: `model-router.js` (845 lines)
Four responsibilities: routing, request-shape translation, telemetry, and a ~260-line image pipeline. Extraction candidates that invent no new abstractions: image pipeline → `src/utils/image-pipeline.js`; Responses→chat input conversion → `src/utils/response-format.js` (its inverse already lives there). Result: a ~450-line router. Optional, low risk, improves navigability after WS removal.

### 4.5 Duplication at the "third use" threshold
- SSE reader loop: 3+ near-identical copies (openai, responses, + dialect variants in anthropic/gemini). Justifiable to factor into one `iterateSseLines(reader)` helper — openai/responses copies are line-for-line.
- `buildHeaders`: 2 identical + 1 variant. `excludeParams` strip loop: 7 copies (trivial 5-liner; leave).
- `adapterModel` require: the fix is deletion (see 3.2) + one `requireAdapterModel()` guard — deduplicates and enforces fail-fast.

### 4.6 Misc correctness nits
- `sse.js:114-117, 136-140`: `?? 0` on context invariants — if the router ever fails to build stats, clients display "0 / 1M" instead of crashing. Per repo memory, `result.context` is always set; the defaults are unreachable lies. Guard or drop.
- `tasks.js:88`: `event.extra.result` can TypeError inside an unguarded subscriber loop; one throwing subscriber breaks notification of the rest.
- `estimator.js:53-58`: silent catch → char-ratio guess with zero logging on tiktoken failure.
- `estimator.js:54`: `includes('o1')` model sniffing false-positives.
- `fallback-tracker.js:31,40` + `task-registry.js:115-117`: `||` masks `0` cooldown config.
- `model-router.js:826,831,834`: `quality ||` masks `0`; `maxDimension || 2048` is a guessed number.
- `logs.js:172`: `parseInt(...) || 100` — `limit=0` and `NaN` both silently become 100.
- `health.js:27`: defensive ternary on an invariant.
- `responses.js` route re-implements SSE machinery inline instead of `StreamHandler` — no backpressure, no zero-content guard; divergence risk.
- `events.js`: system-events SSE has no heartbeat and no write-after-close guard.
- `main.js:45`: empty catch around `wsServer.shutdown()` (dies with WS removal).
- Anthropic `finish_reason` mapping passes unknown `stop_reason` values (`refusal`, `pause_turn`) raw to Copilot; Gemini lowercases any reason (`safety`) into non-spec values; `MAX_TOKENS` should map to `length`.

---

## 5. Documentation Drift

- AGENTS.md adapter table lists `kimi`, `alibaba`, `llamacpp` — the registry (`core/adapters.js:13-18`) and config schema only know `gemini, openai, anthropic, responses`. A config using `adapter: "kimi"` fails at boot.
- "Kimi native token counting uses dedicated Moonshot tokenizer endpoints" — no adapter implements `countTokens`; the estimator makes no upstream calls. Stale.
- `modelConfig.enable_thinking` is a live, undocumented config field (`model-router.js:437`) not validated by config-schema.
- `config.example.json` gaps: no `capabilities.thinking: "chat_template_kwargs"` example, no `excludeParams`, no `mediaStorage`, no `providerVisionLimits`, no `localInference`/`llamacpp` example, `kimi-chat` endpoint contradicts current guidance.
- Chat fallback documented but unimplemented (3.1).
- AGENTS.md WebSocket method table needs pruning with the WS removal.

---

## 6. Dependencies & Tests

**Dependency audit** (zero-dependency philosophy lens):
| Dep | Verdict |
|---|---|
| `express` | **Keep** — 300MB body limit + error middleware re-verification against Copilot BYOK is high-churn; justified infrastructure |
| `cors` | **Replace** — ~15 lines of stdlib headers + OPTIONS handling |
| `dotenv` | **Replace** — `node --env-file` (Node ≥20.6); the codebase already works around its ESM flakiness (`api-key.js` re-reads `.env` manually) |
| `ws` | **Remove** with the WS subsystem |
| `js-tiktoken` | **Keep** — genuine domain expertise; telemetry accuracy matters |
| `mocha`/`chai`/`supertest` | Replaceable with `node:test` + `node:assert` — mechanical but separate decision; low priority |

Also: `package.json` has **no `engines` field** — code requires Node ≥18, practically ≥20. Add `"engines": { "node": ">=20" }`.

**Test gaps** (prioritized): SSE hot path behavior (reasoning→content injection, zero-content path, thinking-tag stripper across chunk boundaries — zero tests for `format.js`); **task fallback state machine** (most stateful logic in core, untested); ticket registry expiry; image-fetcher SSRF; `http.js` retry/backoff; nLogger rotation. The resilience suite (breaker trips, 503 fail-fast) and load/backpressure tests are good foundations.

---

## 7. WebSocket Removal — Surface Map

The subsystem is cleanly severable. External precondition: the chat app's `client-sdk.js` must drop its WS branch first (it already runs `operationMode: "sse"`; per memory #843 the migration is conceptually done, the code branch just needs deletion).

**Delete:**
- `src/websocket/` — 11 files + `chat.js.bak` (server, connection-manager, protocol, binary-protocol, metrics, request-state, handlers ×5)
- `tests/websocket.audio.test.js`, `websocket.binary.test.js`, `websocket.media.test.js`, `websocket.metrics.test.js`, `websocket.v2.test.js`
- `documentation/api_websocket.md` (or move to `docs/_Archive/`)

**Edit:**
- `src/main.js:35-45` — remove dynamic import, `setupWebSocketServer`, `wsServer` var, shutdown block (also removes the empty catch at :45)
- `package.json` — remove `ws` dependency
- `config.example.json` + live `config.json` — remove `ws` section (live config edit needs your approval; the section becomes inert either way)
- `src/streaming/sse.js:188` — comment references "WebSocket chat.progress" (comment-only)

**Verified clean:** no other file in `src/` imports anything under `websocket/`; no other reference to `/v1/realtime`; `src/config.js` doesn't read `config.ws`. Copilot BYOK uses REST/SSE only — unaffected.

**Post-removal bonus:** `request-state.js` cancellation, `metrics.js`, and the whole binary-protocol layer disappear — roughly 60KB and an entire transport's worth of cognitive load.

---

## 8. Recommended Action Sequence

| Step | Items | Effort | Risk |
|---|---|---|---|
| **1** | P0 fixes 2.1 (stream catch), 2.5 (NaN budget), 2.6 (tool args `{}`), 2.7 (key in logs) | Small | Low — all are deletions/narrowing of catches |
| **2** | P0 2.4 (retry policy) + 2.3 (hang watchdog) | Medium | Medium — changes failure-timing behavior; test against Copilot BYOK + a throttling upstream |
| **3** | P0 2.2 (per-model breakers) + P1 3.1 (fallback tracker + chat fallback) | Medium | Medium — core resilience logic; add the missing fallback tests first |
| **4** | P0 2.8 (responses transformer), 2.9 (SSRF), P1 3.3 (anthropic listModels), 3.4 (images route), 3.6 (media-client) | Small-medium | Low |
| **5** | WebSocket removal (§7) — coordinate with chat-app `client-sdk.js` branch deletion | Medium | Low once chat app branch is gone |
| **6** | P1 3.5 (ticket abort/memory), 3.7 (storage), 3.8 (nLogger upstream) | Medium | Low-medium |
| **7** | P2 cleanup: dead code, estimation hot path, router split, `reasoning_content` gating, `adapterModel` validation + placeholder deletion | Medium | Low |
| **8** | Docs sync (AGENTS.md + config.example.json), `engines` field, dep swaps (cors, dotenv) | Small | Low |

**Not recommended now:** Express replacement, test-runner migration, SSE reader dedup (do it opportunistically when touching those files), token-estimation memoization (measure first — the per-message `await` removal is free, the prefix-hash cache is not obviously needed at your load).

---

## Appendix — Verification Notes

Every P0/P1 finding was read against source in this session, not just reported:
- anthropic.js stream catch (throw at `event.type === 'error'`, catch at loop end) — confirmed verbatim.
- Fallback `recordSuccess` call site (`model-router.js:511`) — confirmed unconditional; `recordSuccess` doc even says "Called when either primary or fallback succeeds" — the bug is documented as intent.
- `http.js` used by all adapters — confirmed via import/call grep in anthropic.js (5 sites) and openai.js.
- `images.js` — full file read (30 lines; the entire route body quoted in §3.4).
- Breaker construction (6 per adapter type, shared map) and half-open flip — confirmed in `core/adapters.js` + `core/circuit-breaker.js`.
- SSE context fix (2026-07-23) — mechanism verified correct; residual `?? 0` defaults and unconditional usage-injection noted in §4.6.
