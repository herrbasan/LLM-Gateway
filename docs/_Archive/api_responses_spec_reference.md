# OpenAI Responses API — Complete Spec Reference

> **Source:** [OpenAI API Reference](https://developers.openai.com/api/reference/resources/responses)  
> **Date:** 2026-06-09  
> **Scope:** All endpoints, request/response schemas, input/output item types, tools, streaming events. For gateway implementation details, see `DEV_PLAN_RESPONSES_SPEC.md`.

---

## 1. Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/responses` | Create a model response |
| GET | `/v1/responses/{response_id}` | Retrieve a response by ID |
| DELETE | `/v1/responses/{response_id}` | Delete a response |
| POST | `/v1/responses/{response_id}/cancel` | Cancel a background response (only `background: true` responses) |
| POST | `/v1/responses/{response_id}/compact` | Compact a response's input (server-side compaction) |
| GET | `/v1/responses/{response_id}/input_items` | List input items (paginated; query: `after`, `limit`, `order`, `include`) |
| POST | `/v1/responses/{response_id}/input_tokens/count` | Count input tokens |

### Primary endpoint

```http
POST /v1/responses
Authorization: Bearer <token>
Content-Type: application/json
```

---

## 2. Request Body

### Top-Level Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | `string` | Yes | Model ID, e.g. `gpt-4o`, `o3`, `gpt-5.4`, `gpt-5.5` |
| `input` | `string` \| `array` | No* | Text, image, file, or audio inputs. Also accepts prior response output items and `function_call_output` items. Replaces Chat Completions `messages`. |
| `instructions` | `string` | No | System/developer message inserted into context. Not carried over with `previous_response_id`. |
| `previous_response_id` | `string` | No | ID of previous response for multi-turn stateful conversations. Mutually exclusive with `conversation`. |
| `conversation` | `string` \| `object` | No | Conversation ID (`"conv_xxx"`) or `{ "id": "conv_xxx" }`. Items from this conversation are prepended to `input`. Mutually exclusive with `previous_response_id`. |
| `max_output_tokens` | `number` | No | Hard upper bound for generated tokens (visible + reasoning). Min: 16. |
| `max_tool_calls` | `number` | No | Max total built-in tool calls across all tools in one response. |
| `temperature` | `number` | No | Sampling temp, 0–2. |
| `top_p` | `number` | No | Nucleus sampling, 0–1. |
| `top_logprobs` | `number` | No | 0–20. Max most-likely tokens per position. |
| `stream` | `boolean` | No | If `true`, response streamed as SSE. |
| `stream_options` | `object` | No | `{ include_obfuscation?: boolean }`. Only when `stream: true`. Obfuscation adds random characters to delta events to normalize payload sizes (side-channel attack mitigation). |
| `tools` | `array` | No | Tools the model may call. See §4 for all tool types. |
| `tool_choice` | `string` \| `object` | No | How the model selects tools. See §4.6 for all values. |
| `parallel_tool_calls` | `boolean` | No | Allow parallel tool calls. |
| `text` | `object` | No | `{ format, verbosity }`. Response format config. `format` can be `{ "type": "text" }`, `{ "type": "json_object" }`, or `{ "type": "json_schema", "name": "...", "schema": {...}, "strict": true }`. `verbosity`: `"low"` \| `"medium"` \| `"high"`. |
| `reasoning` | `object` | No | `{ effort, summary }`. For gpt-5 / o-series. See §9. `generate_summary` is deprecated; use `summary`. |
| `truncation` | `"auto"` \| `"disabled"` | No | `auto` = drop items from beginning to fit context. `disabled` (default) = fail with 400. |
| `store` | `boolean` | No | Store response for later retrieval via `GET /v1/responses/{id}`. |
| `metadata` | `object` | No | Up to 16 key-value pairs. Keys ≤64 chars, values ≤512 chars. |
| `include` | `array` | No | Extra data to include in output. See §8. |
| `moderation` | `object` | No | `{ model }`. Moderation config for input and output. |
| `background` | `boolean` | No | Run response in background. Cancel with `POST /v1/responses/{id}/cancel`. |
| `context_management` | `array` | No | `[ { "type": "compact", "compact_threshold": number } ]`. Server-side compaction config. |
| `prompt` | `object` | No | `{ id, variables, version }`. Prompt template reference. |
| `prompt_cache_key` | `string` | No | Cache key for prompt caching. Replaces `user`. |
| `prompt_cache_retention` | `"in_memory"` \| `"24h"` | No | Cache retention policy. `24h` for extended caching (up to 24h). Default depends on org's data retention policy. |
| `safety_identifier` | `string` | No | Stable user identifier for policy detection. Max 64 chars. Hash username/email. |
| `service_tier` | `"auto"` \| `"default"` \| `"flex"` \| `"priority"` | No | Processing tier. Response body echoes the actual tier used. |
| `user` | `string` | No | **Deprecated.** Replaced by `safety_identifier` and `prompt_cache_key`. |

> *Either `input` or `previous_response_id` must be provided (for stateful continuation).

---

## 3. Input Format

The `input` field accepts multiple shapes. It can be a simple string, an array of `EasyInputMessage` items, or a mix of input items and prior response output items.

### 3.1 Simple string
```json
{ "input": "Hello!" }
```

### 3.2 Array of input messages (`EasyInputMessage`)

`EasyInputMessage` = `{ role, content, phase?, type? }`

```json
{
  "input": [
    { "role": "user", "content": "Hello!" },
    { "role": "user", "content": [
      { "type": "input_text", "text": "What is in this image?" },
      { "type": "input_image", "image_url": "https://example.com/image.png" }
    ]},
    { "role": "assistant", "content": "I see an image.", "phase": "final_answer" }
  ]
}
```

**Roles:** `user`, `assistant`, `system`, `developer`. Instructions given with `developer` or `system` role take precedence over `user` role.

**`phase` field** (assistant messages only): `"commentary"` for intermediate updates (preambles before tool calls) or `"final_answer"` for the completed response. Preserving `phase` is important for GPT-5.5/5.4 tool-heavy flows — missing phase can cause preambles to be treated as final answers.

### 3.3 Tool-result input items (`function_call_output`)

For multi-turn function calling, tool results are fed back as input items:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "The weather in Paris is 15°C."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"function_call_output"` | Always this value. |
| `call_id` | `string` | Must match the `call_id` of a prior `function_call` output item. |
| `output` | `string` \| `array` | Tool result. Usually a string (JSON, plain text, error codes). Can be an array of image/file objects for tools that return media. |

> For reasoning models, all reasoning items from the prior response must also be passed back alongside the `function_call_output` — or use `include: ["reasoning.encrypted_content"]` for stateless multi-turn.

### 3.4 Prior response output items as input

The `input` array can also carry **output items** from a prior response directly (e.g. `message`, `function_call`, `reasoning` items). This is the simplest way to chain turns:

```json
{
  "input": [
    { "role": "user", "content": "Tell me a joke" },
    // ... prior response.output items appended here ...
    { "role": "user", "content": "Tell me another" }
  ]
}
```

### 3.5 Audio input

```json
{
  "type": "input_audio",
  "input_audio": { "data": "base64...", "format": "wav" }
}
```

### 3.6 Input content part types (for message content arrays)

| Part Type | Fields | Description |
|-----------|--------|-------------|
| `input_text` | `text: string` | Plain text input. |
| `input_image` | `image_url: string`, `detail?: "low" \| "high" \| "auto"`, `file_id?: string` | Image URL, data URI, or file reference. |
| `input_file` | `file_id: string`, `filename?: string` | Reference to uploaded file. |
| `input_document` | `file_id: string`, `filename?: string` | Document file reference. |
| `input_audio` | `input_audio: { data, format }` | Audio input (base64, format: `wav`/`mp3`). |

> The gateway passes `input` through untouched when provided by the client. When converting from Chat Completions `messages`, only `text` and `image_url` are currently handled.

---

## 4. Tools

Six categories of tools:

### 4.1 Built-in Tools (OpenAI-native)

| Tool | Shape | Description |
|------|-------|-------------|
| `web_search` | `{ "type": "web_search", "search_context_size"?: "low" \| "medium" \| "high" }` | Search the web. |
| `file_search` | `{ "type": "file_search", "vector_store_ids": ["vs_xxx"], "max_num_results"?: number }` | Search vector stores. |
| `computer_use_preview` | `{ "type": "computer_use_preview", "display_width": number, "display_height": number, "environment"?: { "type": "container_auto", ... } }` | Control a computer. |
| `code_interpreter` | `{ "type": "code_interpreter", "container"?: { "type": "container_auto", ... } }` | Execute Python code. |
| `image_generation` | `{ "type": "image_generation" }` | Generate images using GPT Image. |
| `shell` | `{ "type": "shell", "environment"?: { "type": "local", "skills": [...] } }` | Run shell commands in hosted containers. |

### 4.2 MCP Tools

Third-party integrations via MCP servers:
```json
{
  "type": "mcp",
  "server_label": "my-server",
  "server_url": "https://example.com/mcp",
  "allowed_tools"?: ["tool_a", "tool_b"],
  "require_approval"?: "always" | "never",
  "headers"?: { "Authorization": "Bearer ..." }
}
```

### 4.3 Function Tools

**Flattened shape** (the standard Responses API form):
```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Retrieves current weather for the given location.",
  "parameters": {
    "type": "object",
    "properties": {
      "location": { "type": "string", "description": "City and country e.g. Bogotá, Colombia" }
    },
    "required": ["location"],
    "additionalProperties": false
  },
  "strict": true,
  "defer_loading": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"function"` | Always this value. |
| `name` | `string` | Function name. |
| `description` | `string` | When and how to use the function. |
| `parameters` | `object` | JSON Schema for input arguments. |
| `strict` | `boolean` | Enforce schema adherence. When `true`, `additionalProperties` must be `false` and all fields must be required. Responses API attempts to normalize schemas into strict mode; set `strict: false` to opt out. |
| `defer_loading` | `boolean` | Defer loading until the model decides via `tool_search`. Only gpt-5.4+. |

**Namespaces** group related functions:
```json
{
  "type": "namespace",
  "name": "crm",
  "description": "CRM tools for customer lookup and order management.",
  "tools": [
    { "type": "function", "name": "get_customer_profile", "description": "...", "parameters": {...} }
  ]
}
```

### 4.4 Custom Tools

Free-form text input tools (no JSON schema). The model passes an arbitrary string:
```json
{
  "type": "custom",
  "name": "code_exec",
  "description": "Executes arbitrary Python code."
}
```

**With CFG constraint** (Lark grammar or regex):
```json
{
  "type": "custom",
  "name": "math_exp",
  "description": "Creates valid mathematical expressions.",
  "format": {
    "type": "grammar",
    "syntax": "lark",
    "definition": "start: NUMBER PLUS NUMBER\nNUMBER: /[0-9]+/\nPLUS: \"+\""
  }
}
```

Supported grammar syntaxes: `"lark"` (Lark CFG) and `"regex"` (Rust regex crate syntax).

### 4.5 Tool Search

Deferred tool loading — the model searches for relevant tools at runtime:
```json
{ "type": "tool_search" }
```
Only gpt-5.4 and later models support `tool_search`.

### 4.6 `tool_choice` values

| Value | Meaning |
|-------|---------|
| `"auto"` | Model decides whether to call tools (default). |
| `"none"` | Do not call any tool. |
| `"required"` | Must call at least one tool. |
| `{ "type": "function", "name": "..." }` | Force specific function. |
| `{ "type": "custom", "name": "..." }` | Force specific custom tool. |
| `{ "type": "mcp", "server_label": "...", "name": "..." }` | Force specific MCP tool. |
| `{ "type": "web_search" }` | Force built-in tool (Responses API only). |
| `{ "type": "shell" }` | Force shell tool. |
| `{ "type": "allowed_tools", "mode": "auto" \| "required", "tools": [...] }` | Restrict to a subset of available tools. |

---

## 5. Response Format (Non-Streaming)

```json
{
  "id": "resp_xxx",
  "object": "response",
  "created_at": 1741487325,
  "status": "completed",
  "model": "gpt-4o-2024-08-06",
  "output": [
    {
      "type": "message",
      "id": "msg_xxx",
      "role": "assistant",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "...",
          "annotations": []
        }
      ]
    }
  ],
  "output_text": "The full aggregated text output.",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20,
    "total_tokens": 30,
    "output_tokens_details": {
      "reasoning_tokens": 0
    }
  },
  "previous_response_id": null,
  "truncation": "disabled",
  "store": true
}
```

### Response fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique response ID (`resp_...`). |
| `object` | `"response"` | Object type. |
| `created_at` | `number` | Unix timestamp. |
| `status` | `"in_progress"` \| `"completed"` \| `"failed"` \| `"incomplete"` \| `"queued"` \| `"cancelled"` | Response status. |
| `error` | `object` \| `null` | `{ code, message }` if failed. |
| `incomplete_details` | `object` \| `null` | `{ reason: "max_output_tokens" \| "max_tool_calls" }` |
| `instructions` | `string` \| `null` | System message used. |
| `max_output_tokens` | `number` \| `null` | Token limit applied. |
| `max_tool_calls` | `number` \| `null` | Max built-in tool calls applied. |
| `model` | `string` | Model ID. |
| `output` | `array` | Array of output items. See §6. |
| `output_text` | `string` | Convenience field: aggregated text from all `output_text` content parts. |
| `parallel_tool_calls` | `boolean` | Whether parallel calls were allowed. |
| `previous_response_id` | `string` \| `null` | Previous response ID. |
| `reasoning` | `object` \| `null` | `{ effort, summary }` |
| `store` | `boolean` | Whether response was stored. |
| `temperature` | `number` | Sampling temperature used. |
| `text` | `object` | `{ format: { type: "text" \| "json_schema" \| "json_object" }, verbosity: "low" \| "medium" \| "high" }` |
| `tool_choice` | `string` \| `object` | Tool choice used. |
| `tools` | `array` | Tools available. |
| `top_p` | `number` | Top-p value used. |
| `top_logprobs` | `number` \| `null` | Top-logprobs value used. |
| `truncation` | `"auto"` \| `"disabled"` | Truncation strategy. |
| `usage` | `object` | `{ input_tokens, input_tokens_details: { cached_tokens }, output_tokens, output_tokens_details: { reasoning_tokens }, total_tokens }` |
| `user` | `string` \| `null` | User identifier (deprecated). |
| `metadata` | `object` | Attached metadata. |
| `service_tier` | `string` \| `null` | Actual processing tier used. |
| `background` | `boolean` | Whether response was run in background. |
| `completed_at` | `number` \| `null` | Unix timestamp when response completed. |
| `conversation` | `object` \| `null` | `{ id: "conv_xxx" }` if a conversation was used. |
| `moderation` | `object` \| `null` | `{ input: { flagged, categories, ... }, output: { flagged, categories, ... } }` |
| `prompt` | `object` \| `null` | `{ id, variables, version }` if a prompt template was used. |
| `prompt_cache_key` | `string` \| `null` | Prompt cache key used. |

---

## 6. Output Item Types

The `output` array contains typed items. Each item has a `type` discriminator.

### 6.1 `message`

An assistant message output.

```json
{
  "type": "message",
  "id": "msg_xxx",
  "role": "assistant",
  "status": "completed" | "in_progress",
  "phase": "final_answer" | "commentary",
  "content": [
    { "type": "output_text", "text": "...", "annotations": [], "logprobs": [] }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"message"` | Always this value. |
| `id` | `string` | Unique message ID. |
| `role` | `"assistant"` | Always assistant for output messages. |
| `status` | `"completed"` \| `"in_progress"` | Message status. |
| `phase` | `"final_answer"` \| `"commentary"` | Optional. `"commentary"` for intermediate updates, `"final_answer"` for the completed response. |
| `content` | `array` | Array of content parts. See §6.6. |

### 6.2 `function_call`

A request from the model to call a function.

```json
{
  "type": "function_call",
  "id": "fc_xxx",
  "call_id": "call_xxx",
  "name": "get_weather",
  "arguments": "{\"city\":\"NYC\"}",
  "status": "completed" | "in_progress"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"function_call"` | Always this value. |
| `id` | `string` | Unique function call ID. |
| `call_id` | `string` | ID used to match with `function_call_output` input items. |
| `name` | `string` | Function name. |
| `arguments` | `string` | JSON-encoded arguments string. |
| `status` | `"completed"` \| `"in_progress"` | Call status. |

### 6.3 Built-in tool call output items

```json
// web_search_call
{
  "type": "web_search_call",
  "id": "ws_xxx",
  "status": "completed",
  "action": { "query": "...", "results": [...] }
}

// file_search_call
{
  "type": "file_search_call",
  "id": "fs_xxx",
  "status": "completed",
  "results": [{ "file_id": "...", "filename": "...", "score": 0.9 }]
}

// code_interpreter_call
{
  "type": "code_interpreter_call",
  "id": "ci_xxx",
  "status": "completed",
  "code": "print('hello')",
  "outputs": [{ "type": "logs", "logs": "..." }]
}

// computer_call
{
  "type": "computer_call",
  "id": "cc_xxx",
  "status": "completed",
  "action": { "type": "click", "x": 100, "y": 200 },
  "call_id": "call_xxx"
}

// image_generation_call
{
  "type": "image_generation_call",
  "id": "ig_xxx",
  "status": "completed"
}

// shell_call
{
  "type": "shell_call",
  "id": "sh_xxx",
  "status": "completed",
  "command": "ls -la",
  "output": [{ "type": "function_shell_call_output", "stdout": "...", "stderr": "...", "outcome": "success" }]
}
```

### 6.4 `reasoning`

Model's internal reasoning (tokens not visible via API but occupy context window).

```json
{
  "type": "reasoning",
  "id": "rs_xxx",
  "content": [],
  "summary": [
    { "type": "summary_text", "text": "..." }
  ],
  "encrypted_content": "..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"reasoning"` | Always this value. |
| `id` | `string` | Unique reasoning item ID. |
| `content` | `array` | Reasoning content parts (usually empty). |
| `summary` | `array` | Reasoning summaries (only if `reasoning.summary` was requested). Each part: `{ "type": "summary_text", "text": "..." }`. |
| `encrypted_content` | `string` | Encrypted reasoning tokens (only if `include: ["reasoning.encrypted_content"]`). Enables stateless multi-turn with reasoning models. |

### 6.5 `refusal`

Model refusal to answer.

```json
{
  "type": "refusal",
  "id": "rf_xxx",
  "content": [{ "type": "output_refusal", "refusal": "I cannot..." }]
}
```

### 6.6 Content part types (within `message.content`)

| Part Type | Fields | Description |
|-----------|--------|-------------|
| `output_text` | `text: string`, `annotations: array`, `logprobs: array` | Text output. Annotations: see §6.7. Logprobs: see §6.8. |
| `output_refusal` | `refusal: string` | Refusal text. |
| `output_audio` | `data: string`, `transcript: string` | Audio output (base64 + transcript). |

### 6.7 Annotation types (within `output_text.annotations`)

| Annotation Type | Fields | Description |
|-----------------|--------|-------------|
| `file_citation` | `type: "file_citation"`, `file_id: string`, `filename: string`, `index: number` | Citation to a file. |
| `url_citation` | `type: "url_citation"`, `url: string`, `title: string` | Citation to a URL. |
| `text_annotation` | `type: "text_annotation"`, `text: string`, `start: number`, `end: number` | Generic text annotation with character offsets. |

### 6.8 Logprob structure (within `output_text.logprobs`)

```json
{
  "token": "hello",
  "bytes": [104, 101, 108, 108, 111],
  "logprob": -0.5,
  "top_logprobs": [
    { "token": "hello", "bytes": [...], "logprob": -0.5 },
    { "token": "hi", "bytes": [...], "logprob": -2.1 }
  ]
}
```

---

## 7. Streaming Events (SSE)

When `stream: true`, the server emits server-sent events. **There is no `[DONE]` marker.** The stream ends when the client receives `response.completed`, `response.failed`, `response.incomplete`, or `response.queued` (for background responses that never start processing).

**Universal fields on all events:**
- `type: string` — The event type identifier.
- `sequence_number: number` — Monotonic sequence number for ordering events.

### 7.1 Lifecycle Events

| Event | Description |
|-------|-------------|
| `response.created` | Response object created. `status: "in_progress"`. Fields: `response`, `sequence_number`. |
| `response.in_progress` | Response is being generated. Fields: `response`, `sequence_number`. |
| `response.completed` | Response finished successfully. Full `response` object included. Fields: `response`, `sequence_number`. |
| `response.failed` | Response failed. `response.error` contains `{ code, message }`. Fields: `response`, `sequence_number`. |
| `response.incomplete` | Response stopped early. `response.incomplete_details.reason` is `"max_output_tokens"` or `"max_tool_calls"`. Fields: `response`, `sequence_number`. |
| `response.queued` | Response is queued waiting to process (background mode). Fields: `response`, `sequence_number`. |

### 7.2 Output Item Events

| Event | Description |
|-------|-------------|
| `response.output_item.added` | New output item added. Fields: `output_index`, `item`, `sequence_number`. |
| `response.output_item.done` | Output item finalized. Fields: `output_index`, `item`, `sequence_number`. |
| `response.content_part.added` | New content part within an item. Fields: `item_id`, `output_index`, `content_index`, `part`, `sequence_number`. |
| `response.content_part.done` | Content part finalized. Fields: `item_id`, `output_index`, `content_index`, `part`, `sequence_number`. |

### 7.3 Text Events

| Event | Description |
|-------|-------------|
| `response.output_text.delta` | Text delta. Fields: `delta`, `item_id`, `output_index`, `content_index`, `logprobs?`, `sequence_number`. |
| `response.output_text.done` | Text finalized. Fields: `text`, `item_id`, `output_index`, `content_index`, `logprobs?`, `sequence_number`. |
| `response.output_text.annotation.added` | Annotation added. Fields: `annotation`, `annotation_index`, `item_id`, `output_index`, `content_index`, `sequence_number`. |

### 7.4 Refusal Events

| Event | Description |
|-------|-------------|
| `response.refusal.delta` | Refusal text delta. Fields: `delta`, `item_id`, `output_index`, `content_index`, `sequence_number`. |
| `response.refusal.done` | Refusal finalized. Fields: `refusal`, `item_id`, `output_index`, `content_index`, `sequence_number`. |

### 7.5 Function Call Events

| Event | Description |
|-------|-------------|
| `response.function_call_arguments.delta` | Arguments delta. Fields: `delta`, `item_id`, `output_index`, `sequence_number`. |
| `response.function_call_arguments.done` | Arguments finalized. Fields: `arguments`, `name`, `item_id`, `output_index`, `sequence_number`. |

### 7.6 Built-in Tool Lifecycle Events

| Tool | Events |
|------|--------|
| Web Search | `response.web_search_call.in_progress`, `.searching`, `.completed` |
| File Search | `response.file_search_call.in_progress`, `.searching`, `.completed` |
| Code Interpreter | `response.code_interpreter_call.in_progress`, `.interpreting`, `.completed` |
| Code (code delta) | `response.code_interpreter_call_code.delta`, `.done` |
| Computer Use | `response.computer_call.in_progress`, `.completed` |
| Image Generation | `response.image_generation_call.in_progress`, `.generating`, `.partial_image`, `.completed` |
| Shell | `response.shell_call.in_progress`, `.executing`, `.completed` |

**Image generation partial image event fields:**
- `response.image_generation_call.partial_image`: `item_id`, `output_index`, `sequence_number`, `partial_image_index` (0-based), `partial_image_b64` (base64-encoded partial image).

### 7.7 Reasoning Events

| Event | Description |
|-------|-------------|
| `response.reasoning_text.delta` | Raw reasoning delta. Fields: `delta`, `item_id`, `output_index`, `content_index`, `sequence_number`. |
| `response.reasoning_text.done` | Reasoning finalized. Fields: `text`, `item_id`, `output_index`, `content_index`, `sequence_number`. |
| `response.reasoning_summary_part.added` | Summary part added. Fields: `part`, `item_id`, `output_index`, `summary_index`, `sequence_number`. |
| `response.reasoning_summary_part.done` | Summary part done. Fields: `part`, `item_id`, `output_index`, `summary_index`, `sequence_number`. |
| `response.reasoning_summary_text.delta` | Summary text delta. Fields: `delta`, `item_id`, `output_index`, `summary_index`, `sequence_number`. |
| `response.reasoning_summary_text.done` | Summary text done. Fields: `text`, `item_id`, `output_index`, `summary_index`, `sequence_number`. |

### 7.8 MCP Events

| Event | Description |
|-------|-------------|
| `response.mcp_call.in_progress` | MCP call started. Fields: `item_id`, `output_index`, `sequence_number`. |
| `response.mcp_call.completed` | MCP call succeeded. Fields: `item_id`, `output_index`, `sequence_number`. |
| `response.mcp_call.failed` | MCP call failed. Fields: `item_id`, `output_index`, `sequence_number`. |
| `response.mcp_call_arguments.delta` | MCP args delta. Fields: `delta`, `item_id`, `output_index`, `sequence_number`. |
| `response.mcp_call_arguments.done` | MCP args finalized. Fields: `arguments`, `item_id`, `output_index`, `sequence_number`. |
| `response.mcp_list_tools.in_progress` | Listing MCP tools. Fields: `item_id`, `output_index`, `sequence_number`. |
| `response.mcp_list_tools.completed` | MCP tool list received. Fields: `item_id`, `output_index`, `sequence_number`. |
| `response.mcp_list_tools.failed` | Failed to list MCP tools. Fields: `item_id`, `output_index`, `sequence_number`. |

### 7.9 Custom Tool Events

| Event | Description |
|-------|-------------|
| `response.custom_tool_call_input.delta` | Custom tool input delta. Fields: `delta`, `item_id`, `output_index`, `sequence_number`. |
| `response.custom_tool_call_input.done` | Custom tool input finalized. Fields: `input`, `item_id`, `output_index`, `sequence_number`. |

### 7.10 Audio Events

| Event | Description |
|-------|-------------|
| `response.audio.delta` | Audio chunk (base64). Fields: `delta`, `response_id`, `sequence_number`. |
| `response.audio.done` | Audio complete. Fields: `response_id`, `sequence_number`. |
| `response.audio.transcript.delta` | Transcript delta. Fields: `delta`, `response_id`, `sequence_number`. |
| `response.audio.transcript.done` | Transcript complete. Fields: `response_id`, `sequence_number`. |

### 7.11 Error Event

| Event | Description |
|-------|-------------|
| `error` | Stream error. Fields: `type: "error"`, `code`, `message`, `param`, `sequence_number`. |

---

## 8. `include` Parameter

Controls extra data returned in the response. Passed as an array of strings:

```json
{ "include": ["message.output_text.logprobs", "reasoning.encrypted_content"] }
```

| Value | Effect |
|-------|--------|
| `web_search_call.action.sources` | Include web search source URLs. |
| `web_search_call.results` | Include web search results. |
| `file_search_call.results` | Include file search results. |
| `code_interpreter_call.outputs` | Include code interpreter execution outputs. |
| `computer_call_output.output.image_url` | Include image URLs from computer call output. |
| `message.input_image.image_url` | Include image URLs from input messages. |
| `message.output_text.logprobs` | Include logprobs with assistant messages. |
| `reasoning.encrypted_content` | Include encrypted reasoning for stateless multi-turn. |

---

## 9. `reasoning` Object

For gpt-5 and o-series models.

```json
{
  "reasoning": {
    "effort": "low",
    "summary": "auto"
  }
}
```

### `effort` values

Supported values are model-dependent:

| Value | Description |
|-------|-------------|
| `none` | Latency-critical tasks that do not benefit from reasoning. |
| `minimal` | Very light reasoning. |
| `low` | Efficient reasoning with modest latency increase. Good for tool-use, planning, search. |
| `medium` | Balanced quality/latency. Default for gpt-5.5. |
| `high` | Hard reasoning, complex debugging, deep planning. |
| `xhigh` | Very deep reasoning for async workflows. Only when evals justify the cost. |

> Check the relevant model page for which values are supported. Defaults are model-dependent.

### `summary` values

| Value | Description |
|-------|-------------|
| `auto` | Generate a summary using the most detailed summarizer available for the model. |
| `concise` | Short summary. |
| `detailed` | Longer, more detailed summary. |

> `generate_summary` is the deprecated alias for `summary`. Use `summary` instead. Different models support different summary settings. Before using summarizers, organization verification may be required.

### Reasoning output item

When reasoning is enabled, the `output` array includes a `reasoning` item:

```json
{
  "type": "reasoning",
  "id": "rs_xxx",
  "summary": [
    { "type": "summary_text", "text": "**Answering a question**\n\nThe capital of France is Paris..." }
  ]
}
```

---

## 10. Retrieve Endpoint

```http
GET /v1/responses/{response_id}
```

**Query parameters:**
- `include` — Same as the `include` parameter on create.
- `include_obfuscation` — When true, stream obfuscation will be enabled for streaming.
- `starting_after` — Sequence number to resume streaming from.
- `stream` — If `true`, streams the response as SSE (useful for resuming a background response).

Returns the full `Response` object.

---

## 11. Delete Endpoint

```http
DELETE /v1/responses/{response_id}
```

Returns:
```json
{ "id": "resp_xxx", "object": "response", "deleted": true }
```

---

## 12. Cancel Endpoint

```http
POST /v1/responses/{response_id}/cancel
```

Cancels a background response. Only responses created with `background: true` can be cancelled.

Returns the `Response` object with `status: "cancelled"`.

---

## 13. Gateway Mapping Notes

| Responses API | Chat Completions | Gateway Behavior |
|--------------|------------------|------------------|
| `input` | `messages` | Converted if absent; passed through if present. |
| `instructions` | `messages[0]` with `role: "system"` | Extracted from system message if converting. |
| `previous_response_id` | — | Passed through to upstream. Gateway is stateless. |
| `max_output_tokens` | `max_tokens` | Resolved from `max_tokens` or config `maxTokens`. |
| `text.format` | `response_format` | Mapped from `response_format.json_schema`. |
| `reasoning.effort` | — | Mapped from `enable_thinking` (`false` → `low`, `true` → `medium`). |
| `tools` (function) | `tools` | Passed through. |
| `tools` (built-in) | — | Only valid for `responses` adapter. Rejected otherwise. |
| `tool_choice` | `tool_choice` | Passed through. Built-in tool choices only for `responses` adapter. |
| `truncation` | — | Passed through. Gateway does not implement truncation. |
| `store` | — | Passed through. |
| `metadata` | — | Passed through. |
| `stream` | `stream` | Same semantics. |
| `stream_options` | `stream_options` | Passed through. |
| SSE `[DONE]` | `data: [DONE]` | **Responses API does NOT use `[DONE]`.** Gateway must not emit it in native mode. |

---

## 14. Key Differences from Chat Completions

1. **`input` replaces `messages`** — Same content, different field name. Also accepts `function_call_output` and prior response output items.
2. **No `[DONE]` marker** — Stream ends via `response.completed`/`failed`/`incomplete` event.
3. **Built-in tools** — First-class support for web search, file search, code interpreter, computer use, image generation, shell.
4. **Output items** — Structured `output` array with typed items instead of `choices[0].message`.
5. **Stateful by design** — `previous_response_id` enables conversation state (upstream-managed). Also supports `conversation` objects.
6. **`instructions` replaces system message** — Explicit separation from input.
7. **`text.format` instead of `response_format`** — Nested under `text`. Supports `json_schema` with `strict` mode.
8. **`reasoning` block** — Explicit reasoning configuration with effort levels (`none` through `xhigh`) and optional summaries.
9. **Event-driven streaming** — Rich event types (50+) vs. simple `delta.content` chunks. Every event carries `sequence_number`.
10. **Annotations** — Text output can include `file_citation`, `url_citation`, and `text_annotation` annotations.
11. **`output_text` convenience field** — Aggregated text on the response object.
12. **Custom tools** — Free-form text input tools with optional CFG/regex constraints.
13. **Tool search** — Deferred tool loading for large tool surfaces (gpt-5.4+).
14. **Background mode** — Run responses asynchronously, cancel with dedicated endpoint.
15. **`phase` parameter** — Assistant messages can be `"commentary"` or `"final_answer"` to prevent early stopping in tool-heavy flows.
