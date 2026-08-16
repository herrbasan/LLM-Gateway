# Thinking-Effort Granularity — Research & Design Options

> **Date:** 2026-08-15
> **Status:** Research complete, implementation pending decision
> **Question:** Providers now offer granular thinking-effort control (levels, budgets, adaptive modes). The gateway normalizes everything to a boolean `enable_thinking`. Can we expose granular control without breaking OpenAI Chat Completions compatibility?

---

## 1. Current Gateway State

All client thinking control flows through `_resolveThinking()` (`src/core/model-router.js`), which collapses every source into a single boolean `enable_thinking`. Adapters translate:

| Adapter | Boolean becomes | Gate |
|---------|----------------|------|
| `openai` | `chat_template_kwargs.enable_thinking` | `capabilities.thinking === 'chat_template_kwargs'` (llama.cpp/Qwen) |
| `openai` | `payload.reasoning_effort = 'high' \| 'none'` | `capabilities.reasoningEffort` (Grok) |
| `gemini` | `generation_config.thinking_level = 'high' \| 'low'` | Always |
| `anthropic` | `thinking = {type:'enabled', budget 80%} \| {type:'disabled'} \| {type:'adaptive'}` | `thinkingMode: 'adaptive'` capability |
| `responses` | `reasoning = {effort: 'medium' \| 'low'}` | Always |

**Deficiency:** one bit of client control (on/off) maps to providers offering 4–7 distinct levels. Clients cannot pick "medium effort on GLM-5" or "low on Grok."

---

## 2. Provider Capability Matrix (verified 2026-08-15)

### OpenAI (Chat Completions + Responses)
- `reasoning_effort`: `none | minimal | low | medium | high | xhigh | max` — model-dependent
- gpt-5.x base: `minimal..high`; gpt-5.1+ adds `none`; gpt-5.4+ adds `xhigh`; newest adds `max`
- Reasoning models reject `temperature` when `reasoning_effort != none`
- Responses API: same via `reasoning.effort` (preferred form)

### z.AI GLM (OpenAI-compatible endpoint)
- `reasoning_effort`: `none | minimal | low | medium | high | xhigh | max`
- Default `max`; `low`/`medium` coerce → `high`; `xhigh` → `max` (GLM-5.2)
- **GLM-5.3 semantics:** only `max | high | low` accepted; other values error; thinking **cannot be disabled** (`thinking: disabled` throws)
- Coding Plan mapping: `none/minimal/low → low`, `medium/high → high`, `xhigh/max → max`
- Requires `thinking.type: enabled` for effort to take effect (GLM-5.2)
- Our doc (2026-06-13) missed `reasoning_effort` entirely — updated

### Anthropic (Messages)
- `thinking.type: enabled` + `budget_tokens` (≥1024, < max_tokens) — token-level granularity
- **NEW: `output_config.effort`: `low | medium | high | max`** (Opus 4.6 only gets `max`)
- Opus 4.5 needs beta header `effort-2025-11-24`; 4.6 models support natively
- Effort levels scale tokens ~1× / 2.5× / 6× / 12×+[3]
- Effort is a behavioral signal — may change tool-call behavior (fewer, combined calls)
- Dual mechanism: budget for exact control, effort for behavioral signal

### Gemini (Interactions API)
- `generation_config.thinking_level`: `minimal | low | medium | high`
- Gemini 3 Pro: low/high only (medium coming); Flash: all four; defaults high
- `thinking_budget` (token-based, Gemini 2.5 legacy) mutually exclusive with level — 400 if combined
- Thinking **cannot be disabled** on Gemini 3 Pro; `minimal` still needs thought signatures
- OpenAI `reasoning_effort: medium` maps to `thinking_level: high` (official mapping note)

### xAI Grok (OpenAI-compatible)
- `reasoning_effort`: `low | medium | high | xhigh`
- Default `high`; **no `none`** — reasoning cannot be disabled
- grok-4.5: xhigh→high coercion; grok-4.6+: native xhigh
- reasoning models reject `stop`, presence/frequency penalty

### Kimi / Moonshot
- **kimi-k3: `reasoning_effort`: `low | high | max`** (default `max`) — NEW, newer than our docs
- kimi-k2.5/k2.6: `thinking.type: enabled|disabled` only (+ `keep: "all"` on k2.6)
- kimi-k2.7-code: thinking always on, cannot disable
- Reasoning must echo `reasoning_content` in multi-turn tool loops

### DeepSeek
- `thinking: {type}` on/off only
- `reasoning_effort`: `"low" | "high" | "max"` — three real levels, default `high` (corrected 2026-08-15 vs official docs)
- Mapping: `low→low`, `medium→high`, `high→high`, `xhigh→high`, `max→max` — identical for v4-flash and v4-pro
- Anthropic-format: toggle `reasoning: {effort: "none"}` (none disables), effort `output_config: {effort}`
- Sampling params (temperature/top_p/penalties) silently ignored in thinking mode — no error

### MiniMax
- M3: `thinking: {type: adaptive|disabled}` — binary, no levels
- M2.x: levels `off | minimal | low | medium | high` (per third-party integration docs; exact wire format needs verification against official API ref)
- No OpenAI-style `reasoning_effort` documented

### OpenRouter (aggregator — the existence proof)
- Accepts `reasoning: { effort: "none|minimal|low|medium|high|xhigh" }` on Chat Completions + Responses
- Normalizes to each provider's native mechanism downstream
- Proves the OpenAI-compatible surface **can** carry a normalized effort parameter

### llama.cpp / Qwen (local)
- `chat_template_kwargs.enable_thinking` boolean only — no effort levels in template. Level emulation would require budget param upstream support (vLLM-style `reasoning_effort` or template edits) — out of scope

---

## 3. Design Options for the Gateway

### Option A — Accept `reasoning_effort` verbatim (OpenAI-native, pass-through)
Client sends standard OpenAI `reasoning_effort` in the chat body. Router maps enum → per-adapter translation, gated by a new capability.

- **Pros:** zero new vocabulary; any OpenAI SDK client works unchanged; matches OpenRouter's proven pattern; no schema changes to OpenAI surface
- **Cons:** per-model valid-value sets differ (GLM-5.3 errors on unsupported values, Grok has no `none`); needs capability-gating + coercion/invalid-value policy
- **Work:** `_resolveThinking()` gains effort resolution; each adapter gains effort translation; `capabilities.thinkingLevels` (or similar) declares what a model accepts

### Option B — Gateway-native `thinking_effort` param
New first-class request param alongside `enable_thinking` (gateway already has `enable_thinking` as a convenience param, so precedent exists).

- **Pros:** full control of vocabulary; can unify to gateway canonical enum; can carry budget numbers too
- **Cons:** non-standard — clients must learn gateway-specific param; duplicates what `reasoning_effort` already does for OpenAI-compat clients; two params to maintain
- **Work:** router + adapters + docs + task-param allowlist update

### Option C — Extended `enable_thinking` (boolean | string | number)
Overload: `enable_thinking: "high"` or `enable_thinking: 8000` (budget).

- **Pros:** single param, backward compatible
- **Cons:** type-overloading is ugly, undocumented semantics, violates fail-fast (ambiguous types at boundary); OpenAI clients still can't use it without learning it

### Recommendation: **Option A**, with capability-gated translation

Rationale:
1. **It's the OpenAI standard.** OpenAI's own clients, LiteLLM, OpenRouter, and every OpenAI-SDK tool already send `reasoning_effort`. Accepting it verbatim is the only option with zero client-side learning cost.
2. **OpenRouter is the existence proof** that a normalized effort param works on an OpenAI-compatible surface.
3. **Boolean `enable_thinking` stays** as the convenience toggle (false → adapter maps to its native "off" where possible; true → adapter default/medium).
4. **Config declares what each model accepts** — `capabilities.thinkingLevels: ["low","medium","high"]` — and the router coerces or rejects per declared set (fail-fast on undeclared).
5. Anthropic gains budget exposure optionally via `thinking.budget_tokens` (OpenAI clients can't express budgets; that's acceptable — effort levels cover the client surface, budget stays internal/config).

### Sketch of Option A semantics

```
Resolution priority (highest wins):
  request.reasoning_effort      // OpenAI standard field
  request.enable_thinking       // legacy boolean convenience
    true  → adapter-specific default effort (config: capabilities.thinkingDefault)
    false → adapter-specific off value where natively possible
  config.extraBody.reasoning_effort
  (nothing) → send nothing, model defaults
```

Invalid value for the declared set → **reject 400** (fail-fast) unless config declares `thinkingCoercion: "map"`.

### Implementation surface (Option A)
1. `src/core/model-router.js` `_resolveThinking()` — add effort resolution chain
2. `src/adapters/openai.js` — translate effort per capability (reasoning_effort passthrough for GLM/OpenAI/Grok/Kimi-k3; `chat_template_kwargs` boolean for local Qwen)
3. `src/adapters/gemini.js` — effort → `thinking_level` map (none/minimal→minimal or low, low→low, medium→medium, high→high, xhigh/max→high, with model-specific clamping)
4. `src/adapters/anthropic.js` — effort → `output_config.effort` (low/medium/high/max) or existing budget path
5. `src/adapters/responses.js` — `reasoning.effort` passthrough
6. `src/core/config-schema.js` — validate `thinkingLevels`, `thinkingDefault`, `thinkingCoercion`
7. Docs: `documentation/api_rest.md` + AGENTS.md thinking section
8. Tests: effort-resolution matrix per adapter

---

## 4. Effort value normalization map (canonical gateway enum)

Canonical: `none | minimal | low | medium | high | xhigh | max`

| Provider | Fields | none | minimal | low | medium | high | xhigh | max |
|----------|--------|------|---------|-----|--------|------|-------|-----|
| OpenAI | `reasoning_effort` | ✅(5.1+) | ✅ | ✅ | ✅ | ✅ | ✅(5.4+) | ✅(newest) |
| z.AI GLM-5.2 | `reasoning_eff effort` | ✅ skip | ✅ skip | →high | →high | ✅ | →max | ✅ default |
| z.AI GLM-5.3 | `reasoning_effort` | ✗ | ✗ | ✅ | ✗ | ✅ | ✗ | ✅ |
| Anthropic | `output_config.effort` | →disabled? | →disabled? | ✅ | ✅ | ✅ | ✗ | ✅(Opus 4.6) |
| Gemini | `thinking_level` | →minimal | ✅ (Flash) | ✅ | ✅(Flash) | ✅ | →high | →high |
| Grok | `reasoning_effort` | ✗ | ✗ | ✅ | ✅ | ✅ default | ✅(4.6+) | ✗ |
| Kimi k3 | `reasoning_effort` | ✗ | ✗ | ✅ | ✗ | ✅ | ✗ | ✅ default |
| DeepSeek | `reasoning_effort` | ✗ | ✗ | ✅ | →high | ✅ default | →high | ✅ |
| MiniMax M2.x levels | minimal..high | off | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ |

---

## 5. Open Questions for Herrbasan

1. **Invalid-value policy:** reject (400) vs coerce-silently vs coerce-and-log? Recommendation: **reject** — fail-fast philosophy, `thinkingCoercion: "map"` opt-in per model.
2. **Anthropic budget exposure:** expose `budget_tokens` alongside effort? OpenAI clients can't send it (not in spec) — but gateway convenience param could carry it (`thinking_budget`?). Worth it?
3. **Model-default effort on `enable_thinking: true`:** per-model config `thinkingDefault` (e.g. `"high"` for GLM where default is max) or always adapter-medium? Recommendation: config-declared default.
4. **Gemini `minimal` on Flash-only:** when client sends `none`/`minimal` and model only supports low+ (Gemini 3 Pro), reject or clamp? (Current code silently maps false→low. Clamping is status quo.)
5. **Tasks:** should tasks also declare `reasoningEffort` presets (like `maxTokens`)? Symmetric with existing task params.

---

## 6. Sources

- z.AI thinking guide: https://docs.z.ai/guides/capabilities/thinking
- z.AI param concepts: https://docs.z.ai/guides/overview/concept-param
- Anthropic effort: research report (output_config.effort, liteLLM mapping, token scaling data)
- OpenAI reasoning guide: https://developers.openai.com/api/docs/guides/reasoning
- Grok reasoning: https://docs.x.ai/developers/model-capabilities/text/reasoning
- Gemini thinking: third-party verified matrix (thinking_level, mutual exclusivity, model support)
- Kimi platform: kimi-k3 reasoning_effort table (platform docs via research)
- DeepSeek thinking mode: https://api-docs.deepseek.com/guides/thinking_mode (official — corrected the earlier high/max-only claim; user caught the error 2026-08-15)
- MiniMax: OpenClaw/Agentsflare integration docs (third-party; official ref needs verification)
- OpenRouter reasoning param: https://openrouter.ai/docs/api_reference/parameters
