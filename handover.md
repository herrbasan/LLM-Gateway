# Handover: Anthropic Thinking Round-Trip Fix

**Date**: 2026-05-09 00:35  
**Status**: Code changes complete, **needs testing**

---

## Problem

DeepSeek v4-pro (routed through the Anthropic adapter) fails after tool calls with:
```
400: "The `content[].thinking` in the thinking mode must be passed back to the API."
```

Confirmed from log `logs/2026-05-08-22-02-10-gw-xgna5f.log` (lines 47-48).

### Root Cause (3 layers)

1. **Chat client SDK discarded thinking data entirely** — `reasoning_content` from streaming deltas and `_thinking_signature` from the final chunk were never captured, stored, or sent back.

2. **Chat client split model responses into two messages** — When DeepSeek responds with `thinking + tool_use` in ONE response, the chat creates two separate assistant messages:
   - Original exchange → `assistant` (thinking + text)
   - Tool exchange → `assistant` (tool_call only, **NO thinking**)
   
   The Anthropic API requires ALL assistant messages in thinking mode to have thinking blocks. The tool_call message had none.

3. **`<think` tags stripped from API messages** — `conversation.js` `getMessagesForApi()` was stripping `<think` tags from assistant content before sending to the API, losing thinking data for models that embed thinking in content.

### Signature Status

DeepSeek sends `signature: ""` (empty string) in `content_block_start`. Per Anthropic spec, the actual signature should arrive in `content_block_stop`. Diagnostic logging was added to `anthropic.js` to verify this — **untested**.

---

## Solution — Files Changed

### Gateway (`D:\DEV\LLM Gateway`)

**`src/adapters/anthropic.js`** — Added `content_block_stop` diagnostic logging:
```js
// Line ~410: Logs thinking block stop event with signature presence
// If signature is present, captures it for the final chunk's _thinking_signature
```

### Chat Client (`D:\SRV\LLM-Gateway-Chat`)

**`chat/js/client-sdk.js`** — Both SSE and WS paths now:
- Accumulate `reasoning_content` from streaming deltas
- Capture `_thinking_signature` from the final chunk (SSE path)
- Include both in the `done` event as `reasoning_content` and `thinking_signature`

**`chat/js/conversation.js`** — Three changes:
1. `setAssistantComplete()` — Now accepts 4th param `thinkingData` with `reasoning_content` and `thinking_signature`, stores on `exchange.assistant`
2. `getMessagesForApi()` — Assistant messages include `reasoning_content` and `thinking_blocks` (with signature). `<think` tags are NO LONGER stripped. Outer condition also checks `reasoning_content` for exchanges with empty content but thinking data.
3. `getMessagesForApi()` — Tool call messages now include `parentThinking` and `parentContent` from the triggering exchange, producing ONE combined message with thinking + content + tool_calls. The original exchange's assistant is skipped via `consumedByTool` flag.

**`chat/js/chat.js`** — Three changes:
1. `streamResponse()` done handler (normal path) — Passes `event.reasoning_content` and `event.thinking_signature` to `setAssistantComplete()`
2. `streamResponse()` done handler (tool_call path) — Pre-stores thinking data on the exchange before calling `handleToolExecution()`
3. `handleToolExecution()` — Copies thinking data and content from the original exchange to the tool exchange via `exchange.tool.parentThinking` and `exchange.tool.parentContent`. Sets `oldEx.assistant.consumedByTool = true`.

---

## Data Flow (After Fix)

```
1. Gateway streams reasoning_content + _thinking_signature
2. SDK captures both, includes in done event
3. chat.js passes to setAssistantComplete()
4. conversation.js stores on exchange
5. handleToolExecution() copies to tool exchange, marks original consumed
6. getMessagesForApi() builds combined message: thinking + content + tool_calls
7. Gateway adapter formats as Anthropic thinking blocks + tool_use
8. DeepSeek API receives complete thinking round-trip
```

---

## Needs Testing / Known Unknowns

1. **Signature in `content_block_stop`** — Diagnostic logging added but untested. Check next gateway log for `Thinking block stop event` entries. If DeepSeek doesn't send signatures in `content_block_stop` either, thinking blocks will have no signature, and the API may still reject them.

2. **Empty signature handling** — If signatures are always empty from DeepSeek, the adapter creates thinking blocks without signatures: `{ type: "thinking", thinking: "..." }`. Unknown if DeepSeek accepts this. If not, may need to NOT enable thinking when signatures are unavailable, or find another approach.

3. **Non-streaming path** — The fix was designed for streaming (SSE/WS). Non-streaming responses via `normalizeResponse` already include `thinking_blocks` with signatures, but the chat client's handling of non-streaming responses is untested.

4. **Chained tool calls** — The `consumedByTool` flag and `parentThinking`/`parentContent` logic should work for chained tool calls (each tool exchange gets its parent's thinking), but this is untested.

5. **Non-Anthropic adapters** — The `reasoning_content` and `thinking_blocks` fields are now sent on ALL assistant messages regardless of adapter. Non-Anthropic adapters should ignore these fields, but this is untested with all adapters.

6. **Browser cache** — The chat client source files were edited directly. The browser may cache old versions. Hard-refresh or clear cache before testing.

7. **`consumedByTool` persistence** — The flag is stored on `exchange.assistant` and saved via `conversation.save()`. On reload, it's deserialized from IndexedDB. Should work but untested.

---

## Key Memories

- Memory #340 — Full fix details and root cause
- Memory #336 — Previous adapter-side thinking blocks work
- Memory #341 — Previous fix details and next steps
