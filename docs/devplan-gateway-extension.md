# DevPlan: LLM Gateway VS Code Extension

**Status:** Planning  
**Date:** 2026-06-07  
**Target:** VS Code Extension implementing `vscode.LanguageModelChatProvider`

---

## Motivation

The Custom Endpoints (BYOK) feature in VS Code Copilot has fundamental limitations:

| Feature | Custom Endpoints | Extension |
|---|---|---|
| Thinking content rendering | ❌ Plain text only | ✅ `LanguageModelThinkingPart` collapsible blocks |
| Thinking effort dropdown | ❌ No `configurationSchema` | ✅ Model picker dropdown |
| Context window display | ⚠️ Unreliable field mapping | ✅ Direct `maxInputTokens` |
| Tool calling | ⚠️ Fragile SSE parsing | ✅ `LanguageModelToolCallPart` |
| Usage/cache display | ⚠️ Chunk-dependent | ✅ `LanguageModelDataPart` |
| Cancellation | ⚠️ HTTP abort only | ✅ `CancellationToken` |
| Vision proxy | ❌ Not possible | ✅ Extensible |

The DeepSeek V4 for Copilot extension ([github.com/Vizards/deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot)) proves this architecture works and is the recommended approach.

## Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────┐     ┌──────────┐
│  VS Code     │     │ LLM Gateway          │     │ LLM Gateway  │     │ Upstream │
│  Copilot     │────▶│ Extension            │────▶│ (localhost)  │────▶│ APIs     │
│  Chat        │◀────│ (LangModelProvider)  │◀────│ :3400        │◀────│          │
└──────────────┘     └─────────────────────┘     └──────────────┘     └──────────┘
                     Implements:                 HTTP/SSE proxy       OpenAI/
                     vscode.LanguageModelChatProvider                 Anthropic/
                                                                     Gemini/etc.
```

### Key Design Decisions

1. **Proxy, not re-implement**: The extension proxies to the LLM Gateway. It does NOT implement API clients directly. This keeps the gateway as the single source of truth for model config, API keys, and routing.

2. **Dynamic model discovery**: On startup, fetch `GET http://localhost:3400/v1/models` to discover available models. Map gateway model info to `vscode.LanguageModelChatInformation`.

3. **SSE parsing**: The extension parses the gateway's SSE stream and converts chunks to proper VS Code response parts (`LanguageModelThinkingPart`, `LanguageModelTextPart`, `LanguageModelToolCallPart`, `LanguageModelDataPart`).

4. **No local API keys**: The gateway already manages API keys in `config.json`. The extension just needs the gateway URL (default `http://localhost:3400`).

## Implementation Plan

### Phase 1: Core Provider (MVP)

**Files to create:**

```
llm-gateway-copilot/
├── .vscodeignore
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts              # Activate/deactivate, register provider
│   ├── provider.ts               # LanguageModelChatProvider implementation
│   ├── client.ts                 # Gateway HTTP/SSE client
│   ├── models.ts                 # Model info mapping (gateway → VS Code)
│   ├── stream.ts                 # SSE → LanguageModelResponsePart conversion
│   ├── config.ts                 # Extension settings (gateway URL)
│   └── types.ts                  # Shared types
└── resources/
    └── icon.png
```

#### 1.1 `package.json` — Extension Manifest

```json
{
  "name": "llm-gateway-copilot",
  "displayName": "LLM Gateway for Copilot",
  "version": "0.1.0",
  "engines": { "vscode": "^1.96.0" },
  "categories": ["Chat", "Machine Learning"],
  "activationEvents": ["onLanguageModelChatProvider:llm-gateway"],
  "contributes": {
    "configuration": {
      "title": "LLM Gateway",
      "properties": {
        "llm-gateway.url": {
          "type": "string",
          "default": "http://localhost:3400",
          "description": "LLM Gateway base URL"
        }
      }
    }
  }
}
```

#### 1.2 `src/extension.ts` — Entry Point

```typescript
import * as vscode from 'vscode';
import { GatewayChatProvider } from './provider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new GatewayChatProvider(context);
    
    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('llm-gateway', provider)
    );
}

export function deactivate() {}
```

#### 1.3 `src/provider.ts` — Chat Provider

```typescript
class GatewayChatProvider implements vscode.LanguageModelChatProvider {
    // Key methods:
    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]>
    
    async provideLanguageModelChatResponse(
        modelInfo: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void>
    
    async provideTokenCount(
        modelInfo: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        token: vscode.CancellationToken
    ): Promise<number>
}
```

#### 1.4 `src/models.ts` — Model Mapping

Map gateway `/v1/models` response to `vscode.LanguageModelChatInformation`:

| Gateway Field | VS Code Field | Notes |
|---|---|---|
| `id` | `id` | Model identifier |
| `id` | `name` | Display name |
| `owned_by` | `vendor` | "llm-gateway" |
| `maxInputTokens` | `maxInputTokens` | Context window |
| `maxOutputTokens` | `maxOutputTokens` | Output limit |
| `capabilities.vision` | `capabilities.imageInput` | Vision support |
| `capabilities.streaming` | — | Always true |
| `capabilities.tools` / `capabilities.structuredOutput` | `capabilities.toolCalling` | Tool support |

**Thinking effort `configurationSchema`**: If the gateway model supports thinking (detected via config or heuristics), add:

```typescript
configurationSchema: {
    properties: {
        reasoningEffort: {
            type: 'string',
            title: 'Thinking',
            enum: ['none', 'high', 'max'],
            enumItemLabels: ['Off', 'High', 'Max'],
            default: 'high',
            group: 'navigation',
        },
    },
}
```

The selected value is available via `options.modelConfiguration?.reasoningEffort`.

#### 1.5 `src/client.ts` — Gateway Client

- `fetchModels()`: `GET {gatewayUrl}/v1/models`
- `streamChat(request, callbacks, token)`: `POST {gatewayUrl}/v1/chat/completions` with SSE parsing
- Maps `enable_thinking` from `reasoningEffort` config
- Maps VS Code messages to OpenAI format
- Maps VS Code tools to OpenAI `tools` format

#### 1.6 `src/stream.ts` — SSE Conversion

Parse SSE chunks from gateway and emit VS Code parts:

```typescript
interface StreamCallbacks {
    onContent: (text: string) => void;
    onThinking: (text: string) => void;
    onToolCall: (call: ToolCall) => void;
    onUsage: (usage: UsageData) => void;
    onError: (error: Error) => void;
    onDone: () => void;
}
```

Mapping:
- `delta.content` → `new vscode.LanguageModelTextPart(content)`
- `delta.reasoning_content` → `new vscode.LanguageModelThinkingPart(content)`
- `delta.tool_calls` → `new vscode.LanguageModelToolCallPart(id, name, args)`
- `usage` in chunk → `new vscode.LanguageModelDataPart(data, 'usage')`

### Phase 2: Enhanced Features

#### 2.1 Vision Proxy
- Detect image parts in messages
- Use another Copilot model to describe images
- Feed description to gateway model
- (Reuse pattern from DeepSeek extension)

#### 2.2 Gateway Health Monitoring
- Periodic health check to gateway
- Show status in status bar
- Auto-reconnect on gateway restart

#### 2.3 Token Usage Display
- Track prompt/completion tokens per request
- Show in Copilot's native usage display
- Report cache hit rates

### Phase 3: Polish

#### 3.1 Configuration
- Gateway URL setting
- Model filtering (include/exclude specific models)
- Debug logging

#### 3.2 Testing
- Unit tests for SSE parsing
- Integration tests with gateway
- Test with all adapter types (OpenAI, Anthropic, Gemini, llama.cpp)

---

## Non-Public API Surface

The following VS Code APIs used by the DeepSeek extension are **proposed/unofficial** but functional:

| API | Status | Purpose |
|---|---|---|
| `LanguageModelThinkingPart` | Proposed | Thinking content rendering |
| `LanguageModelDataPart` | Stable? | Usage/cache telemetry |
| `configurationSchema` on chat info | Unofficial | Model picker dropdowns |
| `isUserSelectable` on chat info | Unofficial | Model picker visibility |
| `statusIcon` on chat info | Unofficial | Warning icons |
| `modelConfiguration` on options | Unofficial | Reading dropdown values |
| `detail` / `tooltip` on chat info | Unofficial | Model descriptions |

The `LanguageModelThinkingPart` type augmentation is in `vscode.proposed.languageModelThinkingPart.d.ts`.

---

## Delivery Milestones

| Milestone | Content | Effort |
|---|---|---|
| M1: Core Provider | Model listing, chat streaming, thinking parts | 2-3 days |
| M2: Tools & Config | Tool calling, thinking effort dropdown | 1-2 days |
| M3: Vision Proxy | Image description via other models | 1-2 days |
| M4: Polish | Status bar, settings, testing | 1-2 days |

**Total estimated effort:** 5-9 days

---

## References

- [DeepSeek V4 for Copilot](https://github.com/Vizards/deepseek-v4-for-copilot) — Reference implementation
- [VS Code LanguageModelChatProvider API](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChatProvider)
- [LLM Gateway AGENTS.md](../AGENTS.md) — Gateway architecture
- [LLM Gateway REST API](../documentation/api_rest.md)
