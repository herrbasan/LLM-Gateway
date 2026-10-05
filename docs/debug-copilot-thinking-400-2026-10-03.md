# Debug Report — Copilot errors + stuck "open task" / thinking round-trip failures

**Date:** 2026-10-03 · **Prepared by:** exploratory session (read-only, no code changed)
**Scope:** LLM Gateway (`D:\DEV\LLM Gateway`), failures reported from VS Code Copilot (client `192.168.0.100`, UA `node`)
**Status of the gateway during investigation:** running, NOT restarted, config untouched.

---

## 0. Read this first — working tree is AHEAD of HEAD

The running gateway executes **uncommitted working-tree code**, not HEAD (`b69a32c`):

```
M AGENTS.md
M documentation/api_rest.md
M src/routes/chat.js          (+77/−39)
M tests/stream-retry.test.js  (+40)
```

The [chat.js](../src/routes/chat.js) diff reworks the stream-retry semantics:
HEAD's `hasUsableOutput` (reasoning alone = not usable → retry) became
`carriesAnswer` + `carriesOutput` (reasoning **is** output → released immediately;
an attempt that committed with reasoning-only becomes a hard `ZERO_CONTENT` error).
The log proves the running process executes this version: it emitted
`"Upstream streamed reasoning but never produced an answer."` (only exists in the
working tree) since at least 2026-10-02 19:48Z.

**Any fix session must start with `git diff` and decide: commit, revert, or build on
these changes. Do not assume HEAD describes production behavior.**

> **Addendum (2026-10-05):** the working-tree changes listed above were committed as
> `0e81b4e` ("streaming: release reasoning live, report answer-less reasoning streams
> in-band"), so HEAD contains them and the tree no longer lags it. Everything below
> describes the investigation as it stood on 2026-10-03.

---

## 1. Symptoms

1. Copilot: "lots of errors" during agent turns.
2. Copilot: every turn ends with an **open "task"** — a tool-invocation item that
   stays in the running state although the work is finished.
3. Earlier: a "similar thing" was seen in the ChatApp with Kimi; user suspects a
   recent fix made things worse and the problem "spread".

**Mechanism theory (inference, not verified):** in Copilot's agent loop the model
streams thinking + tool calls (turn renders, task opens) → Copilot executes the
tool → sends the follow-up request. If that follow-up fails, Copilot ends the turn
with an error and the last tool item never resolves → the stuck "task". The open
task is a *downstream UI effect* of request failures, most plausibly the DeepSeek
400 bursts below.

---

## 2. Failure families in `logs/main-0.log` (2026-10-02 → 10-03)

Fingerprints with counts (`level = ERROR|WARN`):

| Count | Fingerprint (model / adapter / code) | Meaning |
|---|---|---|
| 30 | `deepseek-flash-chat / anthropic / UPSTREAM_HTTP_400` | 400: **"The `content[].thinking` in the thinking mode must be passed back to the API."** |
| 14 | `deepseek-chat / anthropic / UPSTREAM_HTTP_400` | same 400 |
| 24 | `kimi-k3-chat / anthropic / ZERO_CONTENT` | empty stream |
| 12 | `kimi-chat / anthropic / ZERO_CONTENT` | empty stream |
| 40+26+18 | `space-bunny-chat / openai` | in-stream `JSON error injected into SSE stream` + zero content (free stealth endpoint flakiness — known, unrelated) |
| 624 | `Server: Unhandled server error: fetch failed` | embed proxy / local wrapper unreachable ~12:37Z (operational, separate) |

### 2a. DeepSeek 400 bursts — timeline

Bursts: `12:49:48` (×2), `12:53:06–28` (×6), `13:11:27–49` (×7), `13:14:21+` (×3),
`14:58:16–39` (×6). Intervals inside a burst: 2→2→3→5→10 s = Copilot's exponential
backoff retrying one logical request, then giving up.

**Interleaved successes:** the per-tool-call thinking cache (`src/logs/anthropic-thinking/`,
cwd of the running process — see §4) received writes at `12:55:43–12:57:28` and
`17:14–17:16` — i.e. tool-call turns DID succeed between the bursts. It is not
"every follow-up fails"; something about specific requests trips the 400.

Failure meta of one burst: `distinctClients: 1`, `failure.count` increments across
the burst → one client hammering one broken request shape.

### 2b. Kimi ZERO_CONTENT — inventory-verified shape

`AnthropicAdapter` logs an inventory when a stream yields nothing usable
([anthropic.js:1274-1285](../src/adapters/anthropic.js)). Every logged empty Kimi
stream has:

```json
{"completed":true,"usable":false,
 "events":{"message_start":1,"message_delta":1,"message_stop":1},
 "blockTypes":{},"deltaTypes":{},"textChars":0,"bareJsonLines":0}
```

The upstream **accepted the request and returned a complete, well-formed stream
with zero content blocks** — not a hang, not a parse failure. Clusters: 22:33 (Oct 2),
08:51, 09:03, 10:15 (Oct 3); each cluster = 3 gateway attempts × 3 client retries.
`kimi-chat` = Moonshot `kimi-for-coding` endpoint; `kimi-k3-chat` = `k3` endpoint
(both anthropic adapter, `priorReasoning: "required"` in config).

---

## 3. The machinery under suspicion (the "fix" the user remembers)

DeepSeek's Anthropic-compatible endpoint requires prior `thinking` blocks to be
echoed on tool-use continuations; clients (Copilot, ChatApp) never round-trip
reasoning. The gateway therefore:

1. **Caches thinking per tool call** — on a streamed `stop_reason: tool_use`,
   `saveThinkingBlock(toolUseId, {thinking, signature})`
   ([anthropic.js:1218-1224](../src/adapters/anthropic.js)); disk dir
   `logs/anthropic-thinking` resolved via `process.cwd()`
   ([anthropic.js:42](../src/adapters/anthropic.js)).
2. **Re-injects** on the next request via `injectCachedThinking`
   ([anthropic.js:515-527](../src/adapters/anthropic.js)) — but ONLY for assistant
   messages that have `tool_calls`. Plain thinking+text answers are never cached.
3. **Prior-reasoning policy** — `capabilities.priorReasoning`:
   `'required'` / `'required-with-tools'` / `'ignored'` (config-schema
   [config-schema.js:134-146](../src/core/config-schema.js)); OpenAI adapter
   implements keep/strip + injects `reasoning_content: ""` on tool-call assistant
   messages ([openai.js:529-567](../src/adapters/openai.js)); the **anthropic**
   adapter only checks `!== 'ignored'`
   ([anthropic.js:586](../src/adapters/anthropic.js)) — the required/
   required-with-tools distinction is NOT honored there (inconsistency, unproven relevance).
4. Companion commit history: `1724ee8` (policy moved gateway-side), `8c3d183`
   (openai per-provider policy), `ea84053` (signature_delta + unterminated final
   frame), `9a79780` (zero-content over HTTP + history repair), `b69a32c` +
   working tree (retry rework, reasoning alias).

---

## 4. Anomalies found (facts, unexplained)

1. **cwd-dependent cache paths.** The running gateway's cwd is
   `D:\DEV\LLM Gateway\src`, so its caches live in `src/logs/anthropic-thinking`
   (**5181 files**, actively written) and `src/logs/gemini-signatures`, while
   repo-root `logs\anthropic-thinking` holds 1 test file. Logs land in
   repo-root `logs/`. Any fix that reads/writes these caches must match the
   running process's cwd.
2. **Empty-thinking cache entries.** 8 of the last 40 cache files contain
   `{"thinking":"","signature":"<uuid>"}`. `injectCachedThinking` gates on
   `(cached.thinking || cached.signature)` → these inject as **empty thinking
   blocks**. Likely cause: `thinkingText` accumulates only from `thinking_delta`
   events ([anthropic.js:1112-1119](../src/adapters/anthropic.js)); a provider
   that inlines thinking text on `content_block_start.thinking` would have its
   text silently dropped (the text block has an inline-carry handler at
   [anthropic.js:1194-1211](../src/adapters/anthropic.js); **thinking has none**)
   while `signature_delta` still fills the signature.
3. **Adapter-level captures are not faithful.** A probe that calls the adapter
   directly (bypassing `ModelRouter`) sends a body with NO `max_tokens`, NO
   `thinking`/`output_config` — the router injects `maxTokens`
   (capabilities.maxOutputTokens = 384000) and the model default
   `reasoning_effort: "low"` (→ `output_config.effort: "low"`). Any reproduction
   MUST go through `ModelRouter.routeChatCompletion`.

---

## 5. Verified upstream contract (live probes vs `api.deepseek.com/anthropic`, `deepseek-v4-pro`, 2026-10-03)

All short-history shapes returned **HTTP 200**:

| Probe | Shape | Result |
|---|---|---|
| A | fresh turn, effort low | 200 — thinking block carries a UUID signature |
| B | plain continuation, prior thinking **stripped** | **200** (plain continuations need NO thinking echo) |
| C | continuation, thinking replayed **unsigned** | 200 |
| D | continuation, thinking replayed **signed** | 200 |
| T2a | tool round, real thinking replayed | 200 |
| T2b | tool round, **EMPTY** thinking + signature | 200 |
| T2c | tool round, **NO** thinking block at all | **200** |
| M1/M2 | mixed replay (earlier turn replayed, later stripped) | 200 |

Probe scripts (temp dir, may be GC'd — re-create from this table if gone):
`C:\Users\dave\AppData\Local\Temp\probe-deepseek-thinking.mjs`,
`probe-deepseek-toolround.mjs`, `probe-deepseek-mixed.mjs`.

**Conclusion: the 400 is NOT triggered by any simple shape.** DeepSeek is lenient
in short histories. The trigger lives in the exact body the gateway builds for
real Copilot traffic (long multi-round loops, parallel tool calls, the injected
empty-thinking blocks, or `enforceHistoryInvariants` repairs on real histories).

---

## 6. Hypotheses (ranked, with disconfirming evidence)

### H1 — Real-history shape trips DeepSeek's thinking validation (most probable)
The gateway-transformed body for a specific real history contains something the
short probes don't (e.g. an assistant turn whose ONLY content is an empty
thinking block + tool_use + text ordering; parallel tool calls merged into one
user turn; `enforceHistoryInvariants` dropping/renaming ids so a tool_result
pairs with a different assistant turn than the one whose thinking was injected).
- Supports: 400s interleaved with successes (§2a) → request-shape dependent; error
  text matches DeepSeek's tool-continuation validation.
- Against/limits: T2b/T2c show single-round tolerance; nothing yet reproduces.
- **Falsified if** the captured real payload 400s for a different reason.

### H2 — Kimi empty streams: unsigned/odd thinking echo makes Kimi silently bail
The ChatApp round-trips reasoning (it is the client Kimi was "fixed" for); the
anthropic adapter keeps unsigned `reasoning_content` as a thinking block for
third-party providers ([anthropic.js:577-595](../src/adapters/anthropic.js)).
Kimi's coding endpoint may respond to a degenerate/unsigned thinking history with
a complete-but-empty stream (exactly the observed shape) instead of an error.
- Supports: complete-empty streams only from Kimi models; the "Kimi fix" lineage.
- Unverified: no request capture at the moment of an empty stream yet.

### H3 — Retry rework amplifies (working tree) into client-visible error bursts
Reasoning-only committed attempts now hard-fail `ZERO_CONTENT` (by design, "fail
loud"); free-endpoint flakiness (space-bunny) then surfaces as repeated errors.
Not a bug per se — but it multiplies the error count the user sees. Do not "fix"
by re-hiding errors.

### H4 — Escape hatch (not a root fix): `reasoning_effort: "none"` for deepseek
Disables thinking mode → no passback requirement, kills the 400s, loses reasoning
quality. Also note DeepSeek returned **thinking blocks even when replayed with
none/empty** in every probe — thinking is default-on; only `thinking: {type:"disabled"}`
would switch it off.

---

## 7. Recommended next steps (in order — stop guessing, capture first)

1. **Add a failed-payload dump** in the anthropic adapter on non-200 responses
   (precedent: `src/logs/gemini-failed-payload.json`). Write the full request body
   + status to `src/logs/anthropic-failed-payload.json` (mind the cwd, §4.1).
   Restart the gateway (user restarts per house rules), reproduce one Copilot 400
   burst, read the exact body. This single artifact decides between H1 variants.
2. **Reproduce via `ModelRouter`** with a fetch-mock (capture body) using a
   realistic Copilot history: system prompt, multi-round tool loop with PARALLEL
   tool calls, final thinking+text answer, then a new user message. Replay
   verbatim against DeepSeek. (A previous attempt failed here by bypassing the
   router — §4.3.)
3. **Fix the empty-thinking cache source**: add an inline-carry handler for
   `content_block_start` thinking blocks (mirror the text handler), and decide
   whether `injectCachedThinking` should inject blocks with empty text at all
   (maybe inject only when `cached.thinking` is non-empty).
4. **Kimi**: capture the gateway request that immediately precedes a
   complete-but-empty stream (dump request meta + message roles in the
   zero-content inventory log). Test H2 with a direct probe: unsigned thinking
   block in history → empty stream?
5. **Review `enforceHistoryInvariants`** ([anthropic.js:134](../src/adapters/anthropic.js))
   against real captured bodies: confirm it never drops/reorders thinking or
   tool_use blocks that pairing depends on.
6. After root-cause: consider honoring `priorReasoning` semantics uniformly in the
   anthropic adapter (§3.3), and making cache dirs cwd-independent (derive from the
   logger's log dir instead of `process.cwd()`).

## Candidate fix directions (after capture — do NOT implement blind)

- **If H1-a (empty-thinking injection):** only inject cache blocks with non-empty
  thinking; fix the stream-side loss (§7.3). Small, safe, testable.
- **If H1-b (long-history validation):** replay thinking for ALL assistant turns —
  extend the cache beyond tool calls (key by hash of assistant text), or keep a
  per-conversation rolling replay. Bigger; needs the payload first.
- **If H2 (Kimi):** drop unsigned thinking blocks for providers that answer empty
  (or make it per-model capability), so degenerate histories can't produce
  silent-empty generations.
- **Either way:** the retry machinery (working tree) should stay "fail loud" — the
  errors are truthful; the fix belongs under them.

---

## Appendix — how to re-derive the evidence

```powershell
# failure fingerprints, today
$lines = Get-Content "D:\DEV\LLM Gateway\logs\main-0.log"
$lines | Where-Object { $_ -match '"level":"(ERROR|WARN)"' } | ForEach-Object {
  $j = $_ | ConvertFrom-Json; $j.meta.failure.fingerprint } | Group-Object |
  Sort-Object Count -Descending | Select-Object -First 15 Count, Name

# DeepSeek 400 bodies
$lines | Where-Object { $_ -like '*thinking*must be passed back*' } | Select-Object -Last 3

# Kimi empty-stream inventory
$lines | Where-Object { $_ -like '*Anthropic stream produced nothing usable*' } | Select-Object -Last 3
```

- Active log: `logs/main-0.log` (session `gw-s9giv5` today; gateway NOT restarted since).
- Real thinking cache: `src/logs/anthropic-thinking/` (5181 files; DeepSeek ids
  start `call_`, Anthropic native `toolu_`).
- Config refs: `deepseek-chat` [config.json:753](../config.json),
  `deepseek-flash-chat` [config.json:782](../config.json) — both
  `endpoint: https://api.deepseek.com/anthropic`, `reasoning_effort: "low"`,
  `priorReasoning: "required-with-tools"`, `maxOutputTokens: 384000`.
