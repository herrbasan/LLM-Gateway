# MCP Tool Call Implementation Plan

## Overview

Implement structured tool call events in the LLM Gateway for MCP integration. Follows the interface specification in `mcp_tool_call_interface_spec.md`.

**Status:** Ready for implementation  
**Estimated Effort:** 2-3 days  
**Dependencies:** None (self-contained change)

---

## Files to Modify

### Core Detection Logic

| File | Change | Lines |
|------|--------|-------|
| `src/streaming/sse.js` | Add tool call event types to SSE formatter | ~20 |
| `src/streaming/tool-call-detector.js` | **NEW** - Stream transform for detection | ~150 |
| `src/adapters/base-adapter.js` | Integrate detector into adapter response pipeline | ~30 |

### Route Updates

| File | Change | Lines |
|------|--------|-------|
| `src/routes/chat.js` | Add `finish_reason` and `tool_calls` to done event | ~15 |

### Tests

| File | Change | Lines |
|------|--------|-------|
| `tests/unit/tool-call-detector.test.js` | **NEW** - Unit tests for detector | ~200 |
| `tests/integration/tool-calls.test.js` | **NEW** - End-to-end streaming tests | ~150 |

---

## Implementation Steps

### Phase 1: Tool Call Detector (Day 1)

**Goal:** Create the core detection logic.

**Reference:** Interface Spec §Tool Call Detection (Gateway Internal)

1. **Create `src/streaming/tool-call-detector.js`**
   - Export a transform stream class `ToolCallDetector`
   - Constructor accepts `options`:
     - `enabled` (boolean) - detection active flag
     - `pattern` (string) - detection pattern, default `__TOOL_CALL__`
   - Maintain internal buffer for cross-chunk matching
   - Track code fence state (``` detection)
   - Extract complete JSON, validate with `JSON.parse()`
   - Emit events via callback: `onToolCallStart`, `onToolCallDone`

2. **Key algorithm:**
   ```javascript
   // On each chunk:
   // 1. Append to buffer
   // 2. Update code fence state
   // 3. While pattern found in buffer AND not in code fence:
   //    a. Extract JSON after pattern
   //    b. If valid JSON: emit tool_call.start + tool_call.done
   //    c. Remove pattern + JSON from buffer
   // 4. Yield remaining buffer as content chunks
   ```

3. **Buffer limits:**
   - Max buffer size: 64KB (prevent memory issues)
   - On overflow: flush buffer as raw content, reset

**Acceptance:** Unit tests pass for all test cases in spec Appendix.

---

### Phase 2: Adapter Integration (Day 1-2)

**Goal:** Wire detector into adapter streaming pipeline.

**Reference:** Interface Spec §SSE Event Types

1. **Modify `src/adapters/base-adapter.js`**
   - Import `ToolCallDetector`
   - In streaming response method:
     - Check if detection should be enabled (tools present or `__TOOL_CALL__` in system prompt)
     - If enabled: pipe LLM stream through `ToolCallDetector`
   - Detector callbacks emit SSE events:
     - `onToolCallStart` → `event: tool_call.start`
     - `onToolCallDone` → `event: tool_call.done`

2. **Modify `src/streaming/sse.js`**
   - Ensure SSE formatter handles new event types
   - No special formatting needed (plain JSON data)

**Acceptance:** Integration tests pass - events flow from adapter to SSE.

---

### Phase 3: Chat Route Updates (Day 2)

**Goal:** Add tool call metadata to final `done` event.

**Reference:** Interface Spec §Complete Event Sequence Examples

1. **Modify `src/routes/chat.js`**
   - Track tool calls encountered during stream
   - On stream completion, include in `done` event:
     - `finish_reason`: `"tool_calls"` if tools called, else `"stop"`
     - `tool_calls`: Array of all tool calls from the response

2. **Example output:**
   ```javascript
   {
     "usage": {...},
     "context": {...},
     "finish_reason": "tool_calls",
     "tool_calls": [
       {"index": 0, "id": "call_abc", "name": "recall", "arguments": {...}}
     ]
   }
   ```

**Acceptance:** `done` event contains correct `finish_reason` and `tool_calls` array.

---

### Phase 4: Testing (Day 2-3)

**Goal:** Comprehensive test coverage.

**Reference:** Interface Spec §All sections

1. **Unit tests (`tests/unit/tool-call-detector.test.js`)**
   - Single tool call detection
   - Tool call split across chunks
   - Tool call inside code fence (ignored)
   - Multiple tool calls in one stream
   - Malformed JSON handling
   - Buffer overflow handling

2. **Integration tests (`tests/integration/tool-calls.test.js`)**
   - Full request/response with tool calls
   - Event sequence validation
   - `finish_reason` verification
   - Backward compatibility (no tools in request)

**Acceptance:** All tests pass, coverage >80% for new code.

---

## Migration / Rollout

### Feature Flag

Add temporary config option:

```json
// config.json
{
  "features": {
    "mcp_tool_call_events": true
  }
}
```

Detector only activates when `features.mcp_tool_call_events === true`.

### Rollback

If issues occur:
1. Set `features.mcp_tool_call_events = false`
2. Gateway returns to raw text streaming
3. Frontend can fall back to text-based parsing

---

## Open Questions to Resolve

1. **Max incomplete buffer time?**
   - If we see `__TOOL_CALL__` but JSON never completes, how long to wait?
   - Suggestion: 5 second timeout, then flush as raw text

2. **Parallel tool call ordering?**
   - If tools arrive out of order in stream, do we reorder by `index`?
   - Suggestion: Emit in arrival order, let frontend sort by `index`

3. **Error event naming?**
   - `tool_call.error` or `error`?
   - Suggestion: `tool_call.error` for parse errors, `error` for gateway errors

---

## Verification Checklist

- [ ] `tool_call.start` events have `index`, `id`, `name`
- [ ] `tool_call.done` events have parsed `arguments` object
- [ ] `done` event has `finish_reason: "tool_calls"` when applicable
- [ ] Tool calls inside code fences are ignored
- [ ] Cross-chunk patterns are detected correctly
- [ ] Buffer overflow handled gracefully
- [ ] Feature flag works for enable/disable
- [ ] Existing tests still pass
- [ ] New tests added and passing

---

## Post-Implementation

After this is stable:
1. Update API documentation
2. Notify frontend team of new event types
3. Remove feature flag (make default behavior)
4. Deprecate old `__TOOL_CALL__` text parsing in frontend
