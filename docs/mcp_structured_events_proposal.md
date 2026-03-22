# MCP Tool Integration: Structured Events Approach

## Context

We are building an MCP (Model Context Protocol) tool integration into our chat frontend. The goal is to let an LLM invoke tools exposed by MCP servers (connected in the browser/frontend) and receive results back to continue the conversation.

The MCP server connections and tool execution already work in the frontend. The piece we're missing is the **reliable detection and handling of tool calls** from the LLM's streaming response.

---

## Current Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Chat UI       │         │  LLM Gateway    │         │   LLM Provider  │
│   (Frontend)    │────────▶│  (Backend)      │────────▶│   (OpenAI, etc) │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                                                    │
        │  SSE Streaming                                     │ Raw text stream
        │  (event: delta)                                    │ with tool calls
        │                                                    │ as plain text
        ▼                                                    │
┌─────────────────┐                                           │
│ MCP Servers     │◀──────────────────────────────────────────┘
│ (Browser-side)  │     Execute tool, return result
└─────────────────┘
```

### Current Flow (Broken)

1. Frontend sends chat request with tool definitions in system prompt
2. Backend streams LLM response as raw text chunks via SSE `event: delta`
3. Frontend parses chunks for the pattern `__TOOL_CALL__({"name": "...", "args": {...}})`
4. When detected, frontend:
   - Stops rendering the tool call text
   - Executes the tool via the MCP server
   - Injects the result as a synthetic user message
   - Resumes streaming

### The Problem

Text-based detection across SSE chunk boundaries is **fragile and unreliable**:

```
Chunk 1: "I'll help you with that.\n__TOOL_CALL__"
Chunk 2: "({\"name\": \"recall\", \"args\": {\"query\": \"general\"}})\n"
```

The `__TOOL_CALL__` pattern may arrive split across multiple chunks, and our current line-buffered parser fails to handle this correctly. Additionally, the LLM sometimes includes the tool call inside code fences which must be ignored.

---

## Proposed Solution: Structured Events

We propose moving tool call detection to the **gateway** and communicating it to the frontend via **structured SSE events**, following the industry standard pattern used by OpenAI, GitHub Copilot, and others.

### Industry Standard Reference

**OpenAI Chat Completions API**, **OpenAI Responses API**, and **GitHub Copilot** all use the same fundamental pattern:

1. **Stream-Through Detection**: Tool calls are streamed as structured events within the same SSE stream
2. **Complete & Re-prompt**: The stream completes naturally; client executes tools and starts a new request with results
3. **Stateless Gateway**: Server does not pause/hold state; each request is independent

This approach keeps the gateway stateless while providing clean structured events for UI handling.

### New Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Chat UI       │         │  LLM Gateway    │         │   LLM Provider  │
│   (Frontend)    │◀────────│  (Backend)      │────────▶│   (OpenAI, etc) │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                                                    │
        │  SSE Streaming                                     │ Raw text stream
        │  ├─ event: delta                                   │ (normalized to
        │  ├─ event: tool_call.start                         │  structured events)
        │  ├─ event: tool_call.delta                         │
        │  ├─ event: tool_call.done                          │
        │  └─ event: done                                    │
        │                                                    │
        ▼                                                    │
┌─────────────────┐                                           │
│ MCP Servers     │◀──────────────────────────────────────────┘
│ (Browser-side)  │     Execute tool, return result
└─────────────────┘
```

### New Flow

1. Frontend sends chat request with tool definitions in system prompt
2. Backend streams LLM response with structured tool call events
3. **Gateway detects** `__TOOL_CALL__` pattern in the text stream
4. **Gateway emits** structured `tool_call.*` events (start, delta, done) instead of raw text
5. **Gateway continues** streaming until natural completion (no pause)
6. Frontend receives `tool_call.done`, executes tool via MCP server
7. Frontend sends **new chat request** with tool results injected as user messages
8. Gateway responds to new request with final assistant response

### Why Not Pause-and-Resume?

An earlier version of this proposal suggested pausing the stream and waiting for tool results before resuming. This approach was rejected because:

| Pause-and-Resume | Complete & Re-prompt (Industry Standard) |
|------------------|------------------------------------------|
| Stateful gateway must hold connections open | Stateless gateway, simple to scale |
| Complex timeout and disconnection handling | Each request independent, fault-tolerant |
| Memory management for paused streams | No retained state between requests |
| Not how OpenAI/Copilot/Anthropic do it | Proven pattern, SDKs expect this |

The gateway remains **stateless** - tool results arrive via a new request, not a resume mechanism.

---

## What We Need from the Gateway

### 1. Tool Call Detection in Stream

The gateway should scan the LLM's streaming text for the pattern:

```
__TOOL_CALL__({"name": "tool_name", "args": {"param": "value"}})
```

This must work across chunk boundaries. When the pattern is complete and valid JSON:

- **Do NOT** stream the raw `__TOOL_CALL__...` text to the frontend
- Extract the JSON payload
- Emit structured events for the tool call
- Continue streaming remaining content (if any)

### 2. New SSE Events

Following OpenAI's pattern, emit these events during streaming:

#### `tool_call.start`
Signals the beginning of a tool call:

```
event: tool_call.start
data: {"index": 0, "id": "tool_123", "name": "recall"}
```

#### `tool_call.delta`
Incremental argument updates (if arguments stream in chunks):

```
event: tool_call.delta
data: {"index": 0, "id": "tool_123", "arguments": "{\"query\": \"gen"}
```

#### `tool_call.done`
Complete tool call with final parsed arguments:

```
event: tool_call.done
data: {"index": 0, "id": "tool_123", "name": "recall", "arguments": {"query": "general"}}
```

The `index` field supports parallel tool calls (0, 1, 2...).
The `id` is a unique identifier for this tool call.

### 3. Complete Event Sequence Example

```
event: delta
data: {"choices": [{"delta": {"content": "I'll search your memories..."}}]}

event: tool_call.start
data: {"index": 0, "id": "tool_1", "name": "recall"}

event: tool_call.delta
data: {"index": 0, "id": "tool_1", "arguments": "{\"query\""}

event: tool_call.delta
data: {"index": 0, "id": "tool_1", "arguments": ": \"general\"}"}

event: tool_call.done
data: {"index": 0, "id": "tool_1", "name": "recall", "arguments": {"query": "general"}}

event: delta
data: {"choices": [{"delta": {"content": ""}}]}

event: done
data: {"usage": {...}, "context": {...}, "finish_reason": "tool_calls", "tool_calls": [{"id": "tool_1", ...}]}
```

### 4. Code Block Guard

The gateway must track whether the stream is inside a markdown code fence (lines between ``` and ```). Tool calls inside code fences should be ignored (the LLM may output them as examples).

---

## What the Frontend Handles

### Current MCP Implementation (Works)

- MCP server connections via browser EventSource/SSE
- Tool execution via `mcp-client.js`
- Tool definitions sent to LLM in system prompt
- UI shows tool cards, connection status, enable/disable toggles

### New Frontend Responsibilities

1. **Listen for `tool_call.*` events** instead of parsing text
2. **Accumulate deltas** to build complete tool calls (following OpenAI SDK pattern)
3. **Display pending state** in UI when tool calls are detected
4. **Execute tool** via `mcpClient.executeTool(name, args)` when `tool_call.done` received
5. **Send new request** with tool results injected as user messages:
   ```json
   {
     "messages": [
       {"role": "user", "content": "Search my memories"},
       {"role": "assistant", "content": "I'll search your memories.", "tool_calls": [{"id": "tool_1", "name": "recall"}]},
       {"role": "user", "content": "[Tool Execution Result for 'recall']\nMemory 1: ...\nMemory 2: ..."}
     ]
   }
   ```
6. **Display result** with success/error states in UI
7. **No more text parsing** for tool calls

### UI States (Already Built)

The frontend already has UI for tool states:
- **Pending:** Spinner + "Running [Tool Name]..."
- **Success:** Green status, collapsible result box
- **Error:** Red status, "Retry" and "Dismiss & Continue" buttons

---

## Example Implementation Details

### Gateway Detection Logic (Pseudocode)

```javascript
let buffer = ""
let inCodeFence = false
const toolCallBuffer = new Map() // index -> {id, name, arguments}

for each chunk from LLM:
    buffer += chunk.text

    // Track code fences
    if chunk.text contains "```":
        inCodeFence = !inCodeFence

    // Skip detection inside code blocks
    if inCodeFence:
        yield delta event with chunk.text
        continue

    // Look for complete tool call patterns
    while buffer contains "__TOOL_CALL__":
        match = extractJsonAfterPattern(buffer, "__TOOL_CALL__")
        
        if match.isComplete:
            const toolCall = {
                index: Object.keys(toolCallBuffer).length,
                id: generateUuid(),
                name: match.name,
                arguments: match.args
            }
            toolCallBuffer[toolCall.index] = toolCall
            
            // Emit structured events (not the raw text)
            yield tool_call.start event
            yield tool_call.done event  // args complete in one go for our pattern
            
            // Remove tool call text from buffer
            buffer = buffer.substring(0, match.startIndex) + buffer.substring(match.endIndex)
        else:
            break  // Wait for more chunks

    // Yield remaining content as delta
    if buffer.length > 0 and not buffer.contains("__TOOL_CALL__"):
        yield delta event with buffer
        buffer = ""

// At stream end
yield done event with {tool_calls: Object.values(toolCallBuffer), finish_reason: tool_calls.length > 0 ? "tool_calls" : "stop"}
```

### Frontend Tool Accumulation (Pseudocode)

```javascript
const toolCalls = new Map() // index -> {id, name, arguments}

for event in sseStream:
    if event.type === 'tool_call.start':
        toolCalls.set(event.index, {id: event.id, name: event.name, arguments: ''})
        ui.showPendingTool(event.name)
        
    else if event.type === 'tool_call.delta':
        const tc = toolCalls.get(event.index)
        if (tc) tc.arguments += event.arguments
        
    else if event.type === 'tool_call.done':
        const tc = toolCalls.get(event.index)
        if (tc) {
            tc.arguments = event.arguments // Replace with parsed JSON
            // Execute tool
            const result = await mcpClient.executeTool(tc.name, tc.arguments)
            collectedResults.push({id: tc.id, name: tc.name, result})
        }
        
    else if event.type === 'done':
        if (event.finish_reason === 'tool_calls') {
            // Send new request with tool results
            await sendChatRequestWithToolResults(collectedResults)
        }
```

---

## Compatibility Notes

### Message Format for Tool Results

When the frontend sends tool results back, the message format should be:

```json
{
  "role": "user",
  "content": "[Tool Execution Result for 'tool_name']\n{result}"
}
```

This is compatible with the existing shim in `getMessagesForApi()` which converts `role: 'tool'` to user messages.

### Backward Compatibility

When no tools are provided in the request, the gateway should work exactly as before (just stream deltas). The tool call detection is only active when:
1. The request includes tool definitions, OR
2. The system prompt contains `__TOOL_CALL__`

### OpenAI-Compatible Finish Reason

The final `done` event should include:
- `finish_reason: "tool_calls"` when tools were called
- `finish_reason: "stop"` for normal completion

This matches OpenAI's behavior and allows agent frameworks to detect tool execution needs.

---

## Questions for Review

1. **Should we support parallel tool calls?** The `index` field is included for future compatibility, but initial implementation could serialize.

2. **Incremental vs atomic tool calls:** Our current `__TOOL_CALL__` pattern likely arrives atomically (complete JSON in one chunk). Should we emit `tool_call.delta` events or just `start` + `done`?

3. **Tool call deduplication:** If the same tool call appears twice in a response, should we deduplicate or emit both?

---

## Status

This document is a proposal awaiting review. Backend implementation will follow once the approach is approved.

**Key Decision:** Adopt the industry-standard "Complete & Re-prompt" pattern (stateless) instead of "Pause & Resume" (stateful).
