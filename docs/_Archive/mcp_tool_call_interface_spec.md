# MCP Tool Call Interface Specification

## Overview

This document defines the SSE (Server-Sent Events) interface between the LLM Gateway and the chat frontend for tool calling via MCP (Model Context Protocol).

**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-03-22

---

## Design Principles

1. **Stateless Gateway** - Gateway does not hold state between requests; tool results arrive via new requests
2. **OpenAI-Compatible Events** - Event structure follows OpenAI's streaming patterns where possible
3. **Vanilla JS Friendly** - No complex types; plain JSON objects that `JSON.parse()` handles easily
4. **Backward Compatible** - Existing chat requests without tools work unchanged

---

## SSE Event Types

### Standard Events (Existing)

```
event: delta
data: {"choices":[{"delta":{"content":"Hello"}}]}

event: done
data: {"usage":{"prompt_tokens":10,"completion_tokens":5},"context":{...}}
```

### New Tool Call Events

#### `tool_call.start`
Emitted when the LLM begins a tool call. Contains the tool name and ID.

```javascript
// Schema
{
  "index": number,      // 0-based index for parallel tool calls
  "id": string,         // Unique tool call ID (e.g., "call_abc123")
  "name": string        // Tool name (e.g., "recall", "search_files")
}

// Example
event: tool_call.start
data: {"index":0,"id":"call_abc123","name":"recall"}
```

#### `tool_call.delta`
Emitted for incremental argument updates. Optional for implementations where arguments arrive atomically.

```javascript
// Schema
{
  "index": number,      // Matches the tool_call.start index
  "id": string,         // Matches the tool_call.start id
  "arguments": string   // Partial JSON string (accumulate to build full args)
}

// Example - arguments arriving in chunks
event: tool_call.delta
data: {"index":0,"id":"call_abc123","arguments":"{\"query\":\"gen"}

event: tool_call.delta
data: {"index":0,"id":"call_abc123","arguments":"eral\"}"}
```

#### `tool_call.done`
Emitted when the tool call is complete with fully parsed arguments.

```javascript
// Schema
{
  "index": number,         // Matches previous events
  "id": string,            // Matches previous events
  "name": string,          // Tool name
  "arguments": object      // Parsed JSON object (not string)
}

// Example
event: tool_call.done
data: {"index":0,"id":"call_abc123","name":"recall","arguments":{"query":"general"}}
```

#### `tool_call.error`
Emitted if the tool call JSON is malformed or parsing fails.

```javascript
// Schema
{
  "index": number,      // Tool call index (if known)
  "id": string,         // Tool call ID (if known)
  "error": string       // Error message
}

// Example
event: tool_call.error
data: {"index":0,"id":"call_abc123","error":"Invalid JSON in tool arguments"}
```

---

## Complete Event Sequence Examples

### Example 1: Single Tool Call

```
// Normal chat content
event: delta
data: {"choices":[{"delta":{"content":"I'll search your memories."}}]}

// Tool call begins
event: tool_call.start
data: {"index":0,"id":"call_abc123","name":"recall"}

// Arguments complete (atomic in our case)
event: tool_call.done
data: {"index":0,"id":"call_abc123","name":"recall","arguments":{"query":"general"}}

// Stream ends with tool_calls finish reason
event: done
data: {
  "usage":{"prompt_tokens":50,"completion_tokens":20},
  "context":{"model":"claude-3-5-sonnet","...":"..."},
  "finish_reason":"tool_calls",
  "tool_calls":[
    {"index":0,"id":"call_abc123","name":"recall","arguments":{"query":"general"}}
  ]
}
```

### Example 2: Text + Tool Call

```
event: delta
data: {"choices":[{"delta":{"content":"Let me check that."}}]}

event: delta
data: {"choices":[{"delta":{"content":" "}}]}

event: tool_call.start
data: {"index":0,"id":"call_def456","name":"get_current_time"}

event: tool_call.done
data: {"index":0,"id":"call_def456","name":"get_current_time","arguments":{"timezone":"UTC"}}

event: done
data: {
  "usage":{"prompt_tokens":30,"completion_tokens":15},
  "context":{...},
  "finish_reason":"tool_calls",
  "tool_calls":[
    {"index":0,"id":"call_def456","name":"get_current_time","arguments":{"timezone":"UTC"}}
  ]
}
```

### Example 3: Multiple Parallel Tool Calls

```
event: delta
data: {"choices":[{"delta":{"content":"I'll search both."}}]}

event: tool_call.start
data: {"index":0,"id":"call_aaa111","name":"recall"}

event: tool_call.start
data: {"index":1,"id":"call_bbb222","name":"search_files"}

event: tool_call.done
data: {"index":0,"id":"call_aaa111","name":"recall","arguments":{"query":"meetings"}}

event: tool_call.done
data: {"index":1,"id":"call_bbb222","name":"search_files","arguments":{"pattern":"*.md"}}

event: done
data: {
  "usage":{...},
  "context":{...},
  "finish_reason":"tool_calls",
  "tool_calls":[
    {"index":0,"id":"call_aaa111","name":"recall","arguments":{"query":"meetings"}},
    {"index":1,"id":"call_bbb222","name":"search_files","arguments":{"pattern":"*.md"}}
  ]
}
```

### Example 4: No Tool Calls (Normal Chat)

```
event: delta
data: {"choices":[{"delta":{"content":"Hello!"}}]}

event: delta
data: {"choices":[{"delta":{"content":" How can I help?"}}]}

event: done
data: {
  "usage":{"prompt_tokens":10,"completion_tokens":6},
  "context":{...},
  "finish_reason":"stop",
  "tool_calls":[]
}
```

---

## Request Flow

### Step 1: Initial Request (With Tools)

**POST** `/v1/chat/completions`

```javascript
{
  "model": "claude-3-5-sonnet",
  "messages": [
    {"role": "system", "content": "You have access to tools..."},
    {"role": "user", "content": "Search my memories"}
  ],
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "recall",
        "description": "Search user's memories",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {"type": "string"}
          },
          "required": ["query"]
        }
      }
    }
  ]
}
```

### Step 2: Gateway Response (SSE Stream)

Stream includes `tool_call.*` events as specified above, ending with `finish_reason: "tool_calls"`.

### Step 3: Frontend Executes Tools

Frontend receives `tool_call.done` events, executes tools via MCP:

```javascript
// Frontend (vanilla JS)
const result = await mcpClient.executeTool("recall", {query: "general"});
// result = "Memory 1: ...\nMemory 2: ..."
```

### Step 4: Follow-up Request (With Tool Results)

**POST** `/v1/chat/completions`

```javascript
{
  "model": "claude-3-5-sonnet",
  "messages": [
    {"role": "system", "content": "You have access to tools..."},
    {"role": "user", "content": "Search my memories"},
    {
      "role": "assistant",
      "content": "I'll search your memories.",
      "tool_calls": [
        {"id": "call_abc123", "name": "recall", "arguments": {"query": "general"}}
      ]
    },
    {
      "role": "user",
      "content": "[Tool Execution Result for 'recall']\nMemory 1: ...\nMemory 2: ..."
    }
  ],
  "stream": true
}
```

### Step 5: Gateway Response (Final Answer)

```
event: delta
data: {"choices":[{"delta":{"content":"Based on your memories..."}}]}

event: done
data: {
  "usage":{...},
  "context":{...},
  "finish_reason":"stop",
  "tool_calls":[]
}
```

---

## Message Format for Tool Results

When sending tool results back to the gateway, use this exact format:

```javascript
{
  "role": "user",
  "content": "[Tool Execution Result for '{tool_name}']\n{result}"
}
```

**Rules:**
- Always use `role: "user"` (not `"tool"`)
- Prefix with `[Tool Execution Result for '{tool_name}']\n`
- `{result}` is the string output from the tool execution
- For errors: `[Tool Execution Result for '{tool_name}']\nError: {error_message}`

**Examples:**

```javascript
// Success
{
  "role": "user",
  "content": "[Tool Execution Result for 'recall']\n- Meeting with team at 3pm\n- Remember to buy milk"
}

// Error
{
  "role": "user",
  "content": "[Tool Execution Result for 'search_files']\nError: Directory not found"
}
```

---

## Error Handling

### Gateway Errors

If the gateway encounters an error during streaming:

```
event: error
data: {"message":"Internal server error","code":500}
```

### Tool Call Parsing Errors

If tool call JSON is malformed:

```
event: tool_call.error
data: {"index":0,"id":"call_abc123","error":"Malformed JSON in tool arguments"}

// Stream continues with any remaining content
event: done
data: {"usage":{...},"finish_reason":"stop","tool_calls":[]}
```

### Client Disconnection

If the client disconnects mid-stream, the gateway cleans up and aborts the upstream request. No special handling needed.

---

## Tool Call Detection (Gateway Internal)

### Pattern to Detect

The gateway scans for this exact pattern in the LLM output:

```
__TOOL_CALL__({"name": "tool_name", "args": {...}})
```

### Code Fence Guard

Tool calls inside markdown code fences (between ``` lines) are **ignored**.

```
// This triggers tool_call events
__TOOL_CALL__({"name": "recall", "args": {"query": "test"}})

// This does NOT trigger tool_call events (inside fence)
```
__TOOL_CALL__({"name": "example", "args": {}})
```
```

### Chunk Boundary Handling

The gateway maintains a buffer to handle patterns split across SSE chunks:

```
// Chunk 1: "__TOOL_CALL__({\"name\": \"rec"
// Chunk 2: "all\", \"args\": {}})"
// Gateway buffers until complete JSON is seen
```

---

## Backward Compatibility

### Detection Activation

Tool call detection is **only active** when:
1. Request includes `"tools"` array, OR
2. System prompt contains the string `__TOOL_CALL__`

Otherwise, the gateway streams raw text without scanning.

### Legacy Clients

Clients that don't understand `tool_call.*` events will:
- Ignore unknown events (standard SSE behavior)
- Still receive `done` event with `finish_reason` and `tool_calls` array
- Can poll the `tool_calls` array at stream end

---

## Open Questions

1. **Maximum tool call buffer size?** What if a tool call pattern starts but never completes?
2. **Timeout for incomplete tool calls?** How long to buffer before giving up?
3. **Multiple tool calls in same chunk?** Should we emit multiple events or batch them?

---

## Appendix: Vanilla JS Consumer Example

```javascript
// Vanilla JS EventSource consumer
const evtSource = new EventSource('/v1/chat/completions?...');
const toolCalls = new Map();

evtSource.addEventListener('delta', (e) => {
  const data = JSON.parse(e.data);
  appendToChat(data.choices[0].delta.content);
});

evtSource.addEventListener('tool_call.start', (e) => {
  const data = JSON.parse(e.data);
  toolCalls.set(data.index, {id: data.id, name: data.name, args: null});
  showPendingTool(data.name);
});

evtSource.addEventListener('tool_call.done', (e) => {
  const data = JSON.parse(e.data);
  const tc = toolCalls.get(data.index);
  tc.args = data.arguments;
  
  // Execute tool
  executeTool(tc.name, tc.args).then(result => {
    // Will send follow-up request with result
  });
});

evtSource.addEventListener('done', (e) => {
  const data = JSON.parse(e.data);
  if (data.finish_reason === 'tool_calls') {
    // Collect results and send follow-up
    sendFollowUpRequest(Array.from(toolCalls.values()));
  }
  evtSource.close();
});
```
