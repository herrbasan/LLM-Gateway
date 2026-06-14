# Copilot Context Window Display Issue

## Problem

VS Code Copilot displays **320K** as the context window for `glm5-chat`, despite the gateway correctly reporting `maxInputTokens: 1000000` (1M). Meanwhile, `minimax-m3-chat` — configured identically — displays correctly at **1M**.

Both models use the `anthropic` adapter and have the same `contextWindow: 1000000` in `config.json`.

## What's Ruled Out

### ❌ Not a Gateway Issue

The gateway reports both models identically and correctly:

```
GET /v1/models →

glm5-chat:       maxInputTokens: 1000000, contextWindow: 1000000, context_length: 1000000
minimax-m3-chat: maxInputTokens: 1000000, contextWindow: 1000000, context_length: 1000000
```

Verified via:
```powershell
(Invoke-RestMethod -Uri 'http://localhost:3400/v1/models').data |
    Where-Object { $_.id -match 'glm|minimax' } |
    Select-Object id, maxInputTokens, contextWindow, context_length
```

The `model-registry.js` `listModels()` method correctly maps `capabilities.contextWindow` to multiple fields (`maxInputTokens`, `contextWindow`, `context_length`, `limit.context`) that Copilot might read.

### ❌ Not a Model Name Recognition Issue (Initial Theory — Flawed)

Initial theory was that Copilot has a hardcoded table of known model names and overrides the gateway's value. This was disproven because neither `glm5-chat` nor `minimax-m3-chat` are "common" model names that Copilot would recognize — yet they display different values.

### ❌ Not an Adapter Difference

Both models use the `adapter: "anthropic"` with identical capability structures. The Anthropic adapter's streaming and non-streaming paths return the same `model` field format for both.

## What We Found

### Copilot BYOK Context Window Resolution (from extension.js source)

Copilot's built-in extension (`copilot/dist/extension.js`) has several code paths for resolving model context windows:

#### 1. Extension-Contributed Endpoints (`LB` class)

```javascript
class LB {
    constructor(e) {
        this._maxTokens = e.maxInputTokens;  // reads from language model registration
    }
    get modelMaxPromptTokens() { return this._maxTokens; }
    get maxOutputTokens() { return 8192; }  // ← HARDCODED to 8192
}
```

#### 2. Anthropic BYOK Provider (`px` class)

When Copilot's Anthropic BYOK provider discovers models, it calls the upstream `/v1/models` endpoint, then checks each model ID against a `_knownModels` database:

```javascript
async getAllModels(t, r) {
    let o = await new D1({ apiKey: r }).models.list();  // calls upstream /v1/models
    let a = {};
    for (let s of o.data) {
        if (this._knownModels && this._knownModels[s.id]) {
            a[s.id] = this._knownModels[s.id];           // use known model info
        } else {
            a[s.id] = {
                maxInputTokens: 1e5,                     // DEFAULT: 100K for unknown!
                maxOutputTokens: 16e3,                   // DEFAULT: 16K output
                name: s.display_name,
                toolCalling: true,
                vision: false,
                thinking: false
            };
        }
    }
}
```

The `_knownModels` database is fetched from a CDN:
```
https://main.vscode-cdn.net/extensions/copilotChat.json
```

#### 3. OpenAI-Compatible BYOK (`ID` function)

```javascript
function ID(n, e, t, r) {
    let o = r;
    t && !o && (o = t[n]);
    let s = o ? o.maxInputTokens + o.maxOutputTokens : 128e3;  // total context
    let c = {
        limits: {
            max_context_window_tokens: s,
            max_prompt_tokens: o?.maxInputTokens || 1e5,  // ← defaults to 100K if not provided
            max_output_tokens: o?.maxOutputTokens || ...
        }
    };
}
```

#### 4. Token Overhead Subtraction

Copilot subtracts a small overhead (`DUe`, likely 3 tokens) and a prompt base count (`r`) from the model's `maxInputTokens`:
```javascript
maxInputTokens: e.modelMaxPromptTokens - r - DUe
```

### The Custom Endpoint Provider

The models are registered in Copilot as `customendpoint/BADKID/glm5-chat` and `customendpoint/BADKID/minimax-m3-chat`. The `BADKID` vendor prefix indicates these are registered by a **VS Code extension** (not Copilot's built-in BYOK), likely the kilo-code extension or a similar custom endpoint provider.

**This extension is the missing link.** It determines how it reads `maxInputTokens` from the gateway's `/v1/models` response and passes it through to Copilot's `LanguageModelChatProvider` API. The extension's code controls what Copilot ultimately sees.

## The 320K Mystery

The number 320K (327,680) does not match any obvious default:
- Copilot's default for unknown Anthropic models: **100K** (`1e5`)
- Copilot's default for unknown OpenAI-compatible models: **100K** (`1e5`)
- Copilot's fallback total context: **128K** (`128e3`)
- GLM-5 official context window: **200K** (per z.AI docs)

The 320K value must be coming from the **custom endpoint extension** that registers the `BADKID` provider — either from its own internal logic, a config file, or a transformation it applies to the gateway's reported value.

## Next Steps (When Revisiting)

1. **Identify the `BADKID` extension** — search VS Code extensions for which one registers the `customendpoint/BADKID` provider. Candidates:
   - `kilo-code` extension
   - `continue` extension
   - A custom local extension

2. **Inspect that extension's source** — find how it reads `maxInputTokens` from `/v1/models` and whether it applies any transformation or cap.

3. **Check the CDN known-models list** — fetch `https://main.vscode-cdn.net/extensions/copilotChat.json` and search for any GLM or MiniMax entries that might influence the display.

4. **Alternative workaround** — if the extension is the bottleneck, consider registering the gateway directly via Copilot's built-in OpenAI-compatible BYOK settings instead of through a third-party extension.

## Key Files

| File | Relevance |
|------|-----------|
| `config.json` (lines 358-371) | `glm5-chat` model config — `contextWindow: 1000000` |
| `config.json` (lines 486-501) | `minimax-m3-chat` model config — `contextWindow: 1000000` |
| `src/core/model-registry.js` (lines 140-160) | `listModels()` — maps `contextWindow` to `maxInputTokens` |
| `copilot/dist/extension.js` | Copilot BYOK context window resolution logic |

## Session Context

- **Date:** 2026-06-13 / 2026-06-14
- **Status:** Investigation paused — root cause narrowed to the custom endpoint extension (`BADKID` provider)
