# Issue: kimi-k3 failure silently breaks VS Code Copilot history — 2026-08-21

**Status**: DIAGNOSIS IN PROGRESS — history-poisoning hypothesis unconfirmed, reproduction not yet done.

**TL;DR for next session**: When a kimi-k3 (Anthropic-adapter, Kimi Coding API) stream fails mid-flight — observed failure was HTTP 429 "engine is currently overloaded" — VS Code Copilot's BYOK chat history appears to get poisoned. Subsequent turns fail **even after switching models**. Gateway-side failure handling was verified correct; the suspicion is a malformed/partial assistant message persisted in Copilot's history and resent on every turn. **The failure injection + wiretap reproduction plan below is the next move.** Chat-side silent failure (chat app not surfacing the 429) is a separate, known gap.

---

## 1. Observed failure (log evidence)

Log file: `logs/2026-08-21-05-35-39-gw-2in2q0.log` (session gw-2in2q0, started 05:35:39).

### 1a. The kimi-k3 429 — the trigger

```
[2026-08-21T09:00:08.081Z] [INFO] [ChatRoute] Stream start {"model":"kimi-k3-chat","msgCount":42,"streamId":1787302808081}
[2026-08-21T09:00:27.203Z] [ERROR] [StreamHandler] HTTP Error 429: Too Many Requests:
  {"error":{"type":"rate_limit_error","message":"The engine is currently overloaded, please try again later"},"type":"error"}
  {"model":"kimi-k3-chat","adapter":"anthropic","type":"rate_limit_error","code":"RATE_LIMIT"}
```

- `model`: `kimi-k3-chat`, adapter `anthropic`, endpoint Kimi Coding API (`api.moonshot.ai` family).
- 19 s between start and error. **No `Stream end` line for streamId 1787302808081** — correct, it failed.
- Preceded by ~15 successful kimi-k3 turns (msgCount climbing 209 → 239, a long Copilot session).

### 1b. The follow-on symptom (user-reported)

> "When it happens in the VS Code chat, the history breaks and even switching models will result in errors."

One kimi-k3 failure → every subsequent turn errors, regardless of model. Model switching doesn't help. This is the thing to explain.

### 1c. Separate but related: chat-app silent failure

From the chat app (`D:\SRV\LLM-Gateway-Chat`), the same 429 surfaces as nothing — "fails but does so silently." The 2026-08-20 fix (`client-sdk.js` structured error-chunk parsing + `retryAfter`) covered **in-band SSE error chunks**, but a 429 that arrives *before* any SSE headers (as JSON body on a non-2xx response) goes through a different client path. That path is still swallowing the error.

### 1d. Also in the log: gemini-pro zero-content

```
[2026-08-21T05:59:56.683Z] [ERROR] [StreamHandler] Stream produced zero content
  {"usedTokens":56383,"availableTokens":943617,...}
```
Model `gemini-pro-chat`, msgCount 33. Same zero-content re-throw path fired. Handled correctly, worth knowing it happens.

---

## 2. What the gateway does today (verified correct)

Code path for a streaming chat failure before any content:

1. `src/adapters/anthropic.js` `streamComplete()` — `httpRequest` throws on non-OK with `HTTP Error {status}: {body}`. `src/utils/http.js` attaches `type:'rate_limit_error'`, `code:'RATE_LIMIT'`, `retryAfter` on 429 (the 2026-08-20 fix).
2. `src/streaming/sse.js` `process()` catch — since `headersSent === false`, it **re-throws** rather than emitting an in-band error chunk. Also has the zero-content guard: `if (!hasContent)` logs "Stream produced zero content" and throws `ZERO_CONTENT` if headers weren't sent.
3. `src/routes/chat.js` streaming catch — `if (!res.headersSent)` → responds `res.status(429).json({ error: { message, type:'rate_limit_error', code:'RATE_LIMIT', retryAfter } })`.

**Conclusion**: the gateway fails loudly with a proper HTTP status + JSON body. Copilot *does* see a real HTTP error. Whatever breaks afterward is downstream of a correct gateway response.

**Readable-log gap**: stream-start entries are `[INFO]` with no model in many entries (only present when `req.body.model` set — Copilot BYOK always sets it, task-routed requests don't). Errors appear as bare `[ERROR] [StreamHandler]` lines disconnected from the `Stream start` line. The user's gripe: "readable log entries kind of lost their function if we don't log error" — the readable timeline doesn't tell the failure story (start → error, with model + streamId linked). Fix idea (not implemented): log `Stream fail` with model/streamId/duration/error-type in `chat.js` catch, mirroring `Stream end`.

---

## 3. History-poisoning hypothesis (UNCONFIRMED)

Copilot BYOK resends the full message history every turn. If the failed kimi-k3 turn leaves a malformed message in Copilot's stored history — candidates:

- assistant message with empty/`null` content,
- assistant message with a dangling `tool_use`/`tool_calls` and no matching `tool` result,
- partial content that violates a strict upstream's schema (Anthropic-adapter models reject assistant messages with empty content blocks; DeepSeek requires thinking round-trip on tool-call turns — see `deepseek-tool-call-thinking-roundtrip-2026-08-20` repo memory),

…then every subsequent request carries the poison and fails against *any* model. Model switching can't help because the poison is in the history, not the model.

Precedent for "history shape kills requests": repo memory `deepseek-tool-call-thinking-roundtrip-2026-08-20.md` (400 on tool-call continuations when thinking block not round-tripped) and workshop memory #1082 (oversized history → Kimi tokenization failure).

**Alternative hypothesis**: the 429 overload simply persists and every follow-up also 429s. Cheap to distinguish — the follow-up error text tells which (400/schema-ish vs 429).

---

## 4. Reproduction plan (NEXT MOVE — not yet executed)

Induce the failure deterministically instead of waiting for Moonshot overload.

### 4a. Failure injection (not yet implemented)

Add a header-gated hook in `src/routes/chat.js` (streaming branch, right after `Stream start` log):

- If request header `x-gw-simulate-failure: 429` is present **and** config flag `debug.allowSimulatedFailures === true`:
  - log `[WARN] Simulated upstream failure injected` with model/streamId,
  - throw a synthetic error shaped exactly like the real 429 (`status:429, type:'rate_limit_error', code:'RATE_LIMIT', retryAfter`, message body copied from the log line above),
  - this exercises the exact same re-throw → HTTP 429 JSON path as the real failure.
- Fail loud if the header is present but the config flag is off (403 with clear message). Never active by default. Remove after diagnosis.

### 4b. Wiretap capture (tooling exists)

`scripts/copilot_tap.mjs` — proxy on `:3401` logging method/url/model/stream/message-count plus SSE chunks, forwarding to `:3400`.

1. `node scripts/copilot_tap.mjs`
2. Point VS Code BYOK base URL at `http://localhost:3401`.
3. Turn 1: force the failure (simulate header — needs a way to inject a header from Copilot BYOK config, or a one-off curl mimicking Copilot's request shape; the tap log gives us Copilot's exact request shape from a prior normal turn).
4. Turn 2+: send normal follow-ups from the VS Code UI, switch models, send again.
5. The tap log shows the exact request bodies Copilot sends after the failure → inspect for the poisoned message.

### 4c. What to look for

- Does the follow-up request contain an assistant message from the failed turn? What shape (empty content? dangling tool_calls?)?
- What HTTP status/error does the follow-up get — 400 (poison confirmed) or 429 (overload persistent)?
- After model switch: same body resent (confirms history reuse)?

---

## 5. Fix sketches (depend on reproduction outcome)

- **If poisoned history confirmed**: gateway-side sanitizer — detect/repair malformed trailing assistant messages (drop empty assistant turns, strip dangling tool_calls without tool results) before upstream dispatch. Prior art: `injectCachedThinking()` in `anthropic.js` already repairs missing thinking blocks on tool-call turns. Alternatively client-side, but Copilot BYOK isn't ours to patch.
- **Chat-app silence**: fix the non-streaming/non-2xx fetch path in `D:\SRV\LLM-Gateway-Chat` (`client-sdk.js` and/or `chat.js` callers) to parse the gateway's JSON error body and render status/type/retryAfter like the in-band path does.
- **Readable logs**: add `Stream fail` info-level line in `chat.js` catch linking model + streamId + error type, so the timeline reads start → fail.

---

## 6. Context pointers for the next session

- Repo: `d:\DEV\LLM Gateway`. DO NOT restart the gateway or kill node processes (AGENTS.md critical rules). Config with secrets: `config.json`, never push.
- Key files: `src/routes/chat.js` (streaming branch ~L50-110), `src/streaming/sse.js` (process/catch ~L100-240), `src/adapters/anthropic.js` (streamComplete ~L547+, error throw ~L608-611), `src/utils/http.js` (429 typing), `src/server.js` (global error handler ~L202).
- Session memory file: `/memories/session/kimi-k3-silent-fail-2026-08-21.md` (gone next session — this doc is the durable copy).
- Repo memories: `deepseek-tool-call-thinking-roundtrip-2026-08-20.md`, `streaming-safety-nets.md`, `no-choices-deferred-headers-2026-07-28.md`, `firstbyte-signal-leak-2026-07-29.md`.
- Workshop memories: #1102 (kimi-k3 slowness closed), #1082 (history-size Kimi tokenization failure).
- Related repo: chat app at `D:\SRV\LLM-Gateway-Chat` (separate workspace).
