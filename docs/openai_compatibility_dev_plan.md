# OpenAI Compatibility Development Plan

This document outlines the OpenAI `/v1/chat/completions` specification and what the LLM Gateway currently supports vs. what may be needed for full client compatibility — with a specific focus on coding assistants like **Kilo Code**. We also outline the planned architecture for exposing the new **`/v1/responses`** endpoint natively.

**Reference:** `docs/openapi.with-code-samples.yml` (lines 3080-37222)

---

## Currently Implemented

### Request Parameters ✅

| Parameter | Status | Notes |
|-----------|--------|-------|
| `messages` | ✅ Implemented | Array of chat messages with roles |
| `model` | ✅ Implemented | Model ID routing |
| `stream` | ✅ Implemented | SSE streaming |
| `max_tokens` | ✅ Implemented | Output token budget |
| `max_completion_tokens` | ✅ Implemented | Output token budget |
| `temperature` | ✅ Implemented | Sampling temperature |
| `top_p` | ✅ Implemented | Forwarded |
| `frequency_penalty` | ✅ Implemented | Forwarded |
| `presence_penalty` | ✅ Implemented | Forwarded |
| `stop` | ✅ Implemented | Stop sequences |
| `response_format` | ✅ Implemented | json_schema, json_object |
| `extra_body` | ✅ Implemented | Provider-specific params |
| `seed` | ✅ Implemented | Forwarded |
| `tools` | ✅ Implemented | Forwarded |
| `tool_choice` | ✅ Implemented | Forwarded |
| `parallel_tool_calls` | ✅ Implemented | Forwarded |
| `functions` | ✅ Implemented | Forwarded |
| `function_call` | ✅ Implemented | Forwarded |
| `logprobs` | ✅ Implemented | Forwarded |
| `top_logprobs` | ✅ Implemented | Forwarded |
| `stream_options` | ✅ Implemented | Forwarded |
| `n` | ✅ Implemented | Forwarded |

### Response Structure ✅

Non-streaming response:
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "model-id",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}
```

Streaming response (SSE):
```
data: {"id":"...","choices":[{"index":0,"delta":{"content":"..."}}]}
data: [DONE]
```

### Error Format ✅

```json
{
  "error": {
    "message": "Error description",
    "type": "invalid_request_error",
    "code": "ERROR_CODE"
  }
}
```

---

## Not Implemented (OpenAI Extended Features)

### 🔴 Critical Priority — Coding Assistants Will Fail

#### `tools` / `tool_choice` / `parallel_tool_calls` — Function Calling
**Spec ref:** Lines 37204-37217

Allows the model to call external functions (browser, filesystem, shell, etc.).

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Execute a bash command",
        "parameters": {
          "type": "object",
          "properties": {
            "command": { "type": "string" }
          },
          "required": ["command"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true
}
```

**Response with tool call:**
```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "refusal": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "bash",
          "arguments": "{\"command\":\"ls -la\"}"
        }
      }]
    },
    "finish_reason": "tool_calls",
    "logprobs": null
  }]
}
```

**Streaming chunk with tool call:**
```json
{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":"tool_calls"}]}
```

**Why this is critical:** Coding assistants like Kilo Code rely entirely on function calling for file operations, command execution, and code search. Without this, the assistant cannot interact with the workspace.

**Root cause in gateway:** `ModelRouter._buildChatOptions()` (line 290-298) only extracts `messages`, `max_tokens`, `signal`, `temperature`, `systemPrompt`, and `schema`. `tools`, `tool_choice`, and `parallel_tool_calls` are **silently dropped** before reaching adapters.

**The `openai` adapter** (standard Chat Completions) does not forward tools at all. Only the `responses` adapter handles tools, and that's for the `/v1/responses` endpoint — not what standard clients use.

#### `functions` / `function_call` — Legacy Function Calling
**Spec ref:** Lines 37218-37269

Deprecated in favor of `tools`, but still used by older clients and SDK versions.

```json
{
  "functions": [...],
  "function_call": "auto"
}
```

**Impact:** Same chokepoint — dropped by `_buildChatOptions`.

---

### 🟡 High Priority — Degraded Experience

#### `stream_options` — Streaming Configuration
**Spec ref:** Lines 37202-37203

```json
{ "stream_options": { "include_usage": true } }
```

When `include_usage: true`, OpenAI streams an **additional chunk** before `data: [DONE]` containing `usage` statistics and empty `choices`:

```json
{"id":"...","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}
```

**Current state:** Completely unhandled. The `openai` adapter passes through whatever the upstream sends without inspecting `stream_options`.

**Impact:** Clients using the OpenAI SDK or VS Code extensions may experience UI glitches or incomplete token accounting when this final usage chunk is missing or malformed.

#### `max_completion_tokens` — Reasoning Model Support
**Spec ref:** Lines 36913-36919

Newer alternative to `max_tokens` for o-series reasoning models. Includes reasoning tokens in the count.

```json
{ "max_completion_tokens": 4096 }
```

**Current state:** `_resolveChatMaxTokens` only checks `max_tokens` / `maxTokens`. `max_completion_tokens` is **ignored**. Since `max_tokens` is deprecated and rejected by o-series models, this breaks reasoning model support.

**Fix:** Treat `max_completion_tokens` as an alias with higher precedence than `max_tokens`.

#### Response Message Normalization — `refusal` and `function_call`
**Spec ref:** Lines 35483-35611

The OpenAI spec requires every response message to include:
```json
{
  "role": "assistant",
  "content": "...",
  "refusal": null,
  "tool_calls": null,
  "function_call": null,
  "annotations": []
}
```

**Current state:** The gateway passes through upstream responses as-is. If the upstream omits `refusal` or `function_call`, strict TypeScript clients (OpenAI SDK) may fail to parse.

**Impact:** Type safety errors, potential null-reference crashes in client code.

#### `role: "tool"` Message Handling
**Spec ref:** Lines 35483-35622

Tool result messages follow this format:
```json
{"role": "tool", "tool_call_id": "call_abc123", "content": "file contents here"}
```

**Current state:** These pass through `_sanitizeIncomingMessages` untouched (only assistant messages are modified). This is likely safe but **untested** with context compaction and image processing pipelines.

**Risk:** Context compaction or token estimation may assume all messages have string `content`, causing breakage with tool results.

---

### 🟢 Medium Priority

#### `logprobs` + `top_logprobs` — Token Probabilities
**Spec ref:** Lines 36979-36991, 37126-37137

Return log probabilities for output tokens.

```json
{
  "logprobs": true,
  "top_logprobs": 5
}
```

**Response:**
```json
{
  "choices": [{
    "logprobs": {
      "content": [
        { "token": "Hello", "logprob": -0.5, "bytes": [72, 101], "top_logprobs": [...] }
      ]
    }
  }]
}
```

**Impact:** Used by some coding assistants for confidence scoring on generated code.

#### `system_fingerprint` in Responses
**Spec ref:** Lines 37358-37368

Deprecated but still expected by the OpenAI SDK and many clients.

```json
{ "system_fingerprint": "fp_abc123" }
```

**Current state:** Not synthesized. Gateway passes through upstream value only.

**Fix:** Low effort — synthesize `fp_gateway_v2` or pass through from upstream.

#### `n` — Multiple Completions
**Spec ref:** Lines 37156-37167

Generate multiple chat completion choices.

```json
{ "n": 1 }  // default: 1
```

**Current state:** Not handled. Gateway assumes `n=1` implicitly.

---

### Lower Priority (OpenAI Product Features)

| Parameter | Spec Line | Why Not Needed |
|-----------|-----------|----------------|
| `store` | 37061 | OpenAI-specific storage for evals/distillation |
| `metadata` | Via ModelResponseProperties | OpenAI-specific tagging |
| `modalities` | 36907 | Audio output — separate endpoint |
| `audio` | 37021 | Audio output config — separate endpoint |
| `web_search_options` | 36948 | OpenAI web search — not applicable |
| `prediction` | 37168 | Predicted outputs — OpenAI-specific |
| `reasoning_effort` | 36911-36912 | o-series reasoning control — provider-specific |
| `verbosity` | 36909-36910 | Output verbosity control — provider-specific |

---

## Root Cause Analysis

### The `_buildChatOptions` Chokepoint

`src/core/model-router.js` line 290-298:

```js
_buildChatOptions(request, modelConfig) {
    return {
        messages: request.messages || [],
        maxTokens: request.max_tokens,
        signal: request.signal,
        temperature: request.temperature,
        systemPrompt: request.systemPrompt,
        schema: request.response_format?.json_schema?.schema
    };
}
```

This function is the **single point of failure** for OpenAI compatibility. Any parameter not explicitly extracted here is silently discarded before reaching adapters. Parameters currently dropped include:

- `tools`, `tool_choice`, `parallel_tool_calls`
- `functions`, `function_call`
- `frequency_penalty`, `presence_penalty`
- `seed`
- `logprobs`, `top_logprobs`
- `n`
- `stream_options`
- `max_completion_tokens`
- `user`
- `logit_bias`

### Adapter Passthrough Gaps

Even if `_buildChatOptions` extracts parameters, adapters must forward them. The `openai` adapter currently only forwards:
- Non-streaming: `model`, `messages`, `stream`, `max_tokens`, `temperature`, `response_format`
- Streaming: adds `top_p`, `stop`

Missing from `openai` adapter:
- `tools`, `tool_choice`, `parallel_tool_calls`
- `seed`
- `frequency_penalty`, `presence_penalty`
- `logprobs`, `top_logprobs`
- `max_completion_tokens`
- `stream_options`

---

## Adapter-Specific Tool Support Matrix

| Adapter | Native Tool API | Can Support Tools? | Effort |
|---------|----------------|-------------------|--------|
| `openai` | Chat Completions tools | ✅ Direct passthrough | Low |
| `responses` | Responses API tools | ✅ Already implemented | — |
| `anthropic` | Claude tools | ✅ Convert OpenAI ↔ Anthropic format | Medium |
| `gemini` | Function declarations | ✅ Convert OpenAI ↔ Gemini format | Medium |
| `kimi` | Moonshot tools | ✅ Convert OpenAI ↔ Kimi format | Medium |
| `ollama` | Ollama tools | ✅ Some models support it | Low |
| `llamacpp` | llama.cpp tools | ⚠️ Variable by build | Medium |
| `lmstudio` | LM Studio (OpenAI compat) | ✅ Direct passthrough | Low |
| `alibaba` | DashScope tools | ✅ Convert format | Medium |

---

## Streaming Notes

### Standard SSE Events

OpenAI spec defines only:
- `data: {...chunk...}` - streaming chunks
- `data: [DONE]` - completion signal

### `stream_options.include_usage` Behavior

When `stream_options.include_usage: true`:
1. All chunks include `usage: null` (except the final chunk)
2. The final chunk before `[DONE]` has `choices: []` and `usage: {prompt_tokens, completion_tokens, total_tokens}`
3. If the stream is interrupted, the final usage chunk may not be received

**Current gateway behavior:** The gateway strips internal SSE events (`event: context.status`, `event: compaction.*`) from REST responses. However, it does not synthesize or validate the `include_usage` final chunk.

---

## The `/v1/responses` REST Endpoint Definition

While the Gateway converts `/v1/chat/completions` into Responses API format internally via the `responses` adapter when communicating upstream, **there is currently no outward-facing `/v1/responses` endpoint exposed by the REST API itself.**

Clients strictly trying to build agents via the Responses API will hit `404 Not Found` if they query the gateway. The Responses API natively simplifies complex multi-turn logic (such as tying generated messages and outputs implicitly). 

**Requirements for a external `/v1/responses` route:**
1. **New Route Handler**: Create `src/routes/responses.js` capturing parity with `src/routes/chat.js` but tuned for Responses object expectations.
2. **Server Mounting**: Add `app.post('/v1/responses', createResponsesHandler(...))` in `src/server.js`.
3. **Router Enhancement**: Extend `src/core/model-router.js` with a `routeResponse()` primitive alongside `routeChatCompletion()`.
4. **Adapter Mappings**: 
   - Pass `/v1/responses` through cleanly to the internal `responses` adapter natively.
   - For all other adapters (`openai`, `anthropic`, `gemini`), translate the heavily structured Responses payload down into their standard `/v1/chat/completions` or proprietary formats. This requires bidirectional flattening where standard chat completions map back to response envelopes.

---

## Implementation Recommendations

### ✅ Priority 0: Fix the Parameter Chokepoint

1. **Done:** Expanded `_buildChatOptions` to extract all standard OpenAI Chat Completions parameters
2. **Done:** Audited every adapter and properly forwarded extracted parameters in their upstream payload payload

### ✅ Priority 1: Function Calling (`tools`)

For coding assistants like Kilo Code, function calling is essential. The implementation needs:

1. **✅ Request parsing** - Accept `tools`, `tool_choice`, `parallel_tool_calls` in chat handler
2. **🔄 Adapter support** - Pass tools to providers that support them (✅ OpenAI, ✅ Anthropic, ✅ Kimi, ✅ Gemini)
3. **✅ Response normalization** - Convert provider-specific tool call formats to OpenAI format
4. **✅ Streaming support** - Handle partial tool calls in stream deltas (`delta.tool_calls[{index, function: {name, arguments}}]`)
5. **✅ Tool result messages** - Ensure `role: "tool"` messages survive sanitization and context compaction

### ✅ Priority 2: `max_completion_tokens`

Implemented support for `max_completion_tokens` seamlessly swapping in for reasoning models (o-series).

### ✅ Priority 3: `stream_options`

Implemented `include_usage` behavior for streaming responses natively inside SSE handler. Client SDKs accurately record total context.

### Priority 4: `logprobs`

Useful for debugging and quality assurance but adds overhead.

### ✅ Priority 5: Response Normalization

Ensured all response/streaming messages include `refusal: null`, `function_call: null`, and `system_fingerprint` to properly conform when absent.

---

### ✅ Priority 6: `/v1/responses` REST Endpoint

Develop a dedicated endpoint and core router pathways specifically to handle the Responses API shape correctly out-of-the-box (instead of simply adapting Chat Completion payloads internally upstream). Now mapped to `.routeResponse()` within Express mapping cleanly to internal downstream logic.

---

## Files Modified / To Modify

| File | Changes |
|------|---------|
| `src/core/model-router.js` | ✅ Expanded `_buildChatOptions` to extract all standard params; handle `max_completion_tokens`; ensure `role: "tool"` messages survive compaction |
| `src/core/task-registry.js` | Add normalization for `max_completion_tokens` → `max_completion_tokens` (already snake_case) |
| `src/adapters/openai.js` | ✅ Forwarded `tools`, `tool_choice`, `parallel_tool_calls`, `seed`, `frequency_penalty`, `presence_penalty`, `top_p` (non-streaming), `logprobs`, `stream_options`, `max_completion_tokens` |
| `src/adapters/anthropic.js` | ✅ Converted OpenAI tools ↔ Claude tools format |
| `src/adapters/gemini.js` | ✅ Convert OpenAI tools ↔ Gemini function declarations |
| `src/adapters/kimi.js` | ✅ Converted OpenAI tools ↔ Moonshot tools format |
| `src/adapters/*` | Convert Response API payloads to `chatCompletions` locally if applicable |
| `src/utils/response-normalizer.js` (NEW)| ✅ Consolidates normalizing utility for `refusal`, `function_call` & `system_fingerprint` |
| `src/routes/chat.js` | ✅ Inject normalization utility |
| `src/streaming/sse.js` | ✅ Inject normalization utility |
| `src/routes/responses.js` (NEW)| ✅ Implements routing/handling for the incoming `responses` API HTTP requests |
| `src/server.js` | ✅ Expose `/v1/responses` outward endpoint via express |
| `src/streaming/` | ✅ Handle `stream_options.include_usage` final chunk |

---

## Testing Checklist

When testing OpenAI compatibility:

- [ ] Non-streaming completion returns valid `choices` array
- [ ] Streaming completion yields proper SSE format
- [ ] Errors return `{ error: { message, type, code } }`
- [ ] `response_format: json_schema` produces valid JSON
- [ ] `stop` sequences halt generation correctly
- [ ] `seed` produces deterministic results (same model required)
- [x] **`tools` array is accepted and `tool_calls` returned in response**
- [x] **Tool result `role: "tool"` messages accepted in subsequent turns**
- [x] **Streaming tool calls yield valid `delta.tool_calls` chunks**
- [x] **`stream_options.include_usage` yields final usage chunk before `[DONE]`**
- [x] **`max_completion_tokens` treated equivalently to `max_tokens`**
- [x] **Response messages include `refusal: null` and `function_call: null`**
- [ ] `frequency_penalty` / `presence_penalty` forwarded to upstream
- [ ] `logprobs: true` returns log probability data

### April 2026 Known Issues / Current Troubles
- **Adapter schema validation failures**: We encountered aggressive schema validation errors with some strict clients failing on the `[DONE]` marker streaming chunk (`Type validation failed: Value: {"data":"[DONE]","usage":null}`).
- **Gemini empty finish_reason conflict**: Gemini was yielding an empty payload with `finish_reason: "stop"` trailing immediately after throwing `finish_reason: "tool_calls"`. This conflicting state overwrites the `tool_calls` intent for some strict AI assistants. Modified the adapter to suppress empty `stop` closures if tools were already emitted (unless usage metrics are attached, effectively imitating OpenAI's usage chunk).
- **Kimi parse exceptions masking chunks**: The Kimi adapter was dropping valid tool chunks due to a `require('fs')` debug logging bug crashing the local chunk parsing loop. Additionally, `					  ` logic was buffering instead of flushing cleanly before tools, breaking tool JSON structure. Fixed by removing the broken require and safely flushing `reasoningBuffer` inline with text/tool deltas.
*(Remember: restart the Node service to flush the adapter source cache after applying adapter updates)*

### Post-Implementation Bug Fixes (April 2026)

#### `max_tokens` overflow on provider-capped endpoints
Models using the `openai` adapter pointed at DashScope-compatible endpoints (e.g., `al-kimi-chat`) had `contextWindow: 256000` but no `maxOutputTokens` in capabilities. The implicit max token budget calculated `256000 - used - 20% = ~204K`, exceeding DashScope's hard limit of 98304. The provider rejected requests with `Range of max_tokens should be [1, 98304]`.

**Fix:** Added a safety cap in `applyTokenParams()` (`openai` adapter) and `buildChatPayload()` (`alibaba` adapter) that clamps `max_tokens` / `max_completion_tokens` to `capabilities.maxOutputTokens` when configured. Models behind provider-capped endpoints must now declare `maxOutputTokens` in their capabilities config.

**Also affected:** The WebSocket endpoint — since WS uses the same `routeChatCompletion` path, the overflow hit WS clients too.

#### `/v1/responses` endpoint crash (5 runtime errors)
The `routeResponse()` method in `model-router.js` was a skeleton with 5 unresolved references:
- `this.registry.resolveTask()` — does not exist
- `this._validateChatRequest()` — does not exist
- `{ modelConfig, routeModelId }` — wrong destructuring for `resolveModel()` which returns `{ id, config }`
- `this.adapters.getAdapter()` — does not exist (should be `this._getAdapter()`)
- `truncateToContextLimit` — not imported or defined

**Fix:** Replaced the broken implementation with a clean delegation to `routeChatCompletion()` that maps Responses API `input` → `messages`. The explicit `routeResponse()` entrypoint is preserved for future divergence.

#### Unsafe `JSON.parse` in tool argument handling
Both `gemini` and `anthropic` adapters called `JSON.parse(tc.function.arguments)` without try/catch when converting assistant `tool_calls` back to provider-native format. Malformed arguments from LLMs would crash the entire request.

**Fix:** Wrapped parses in try/catch with `{}` fallback in both adapters. Added `parseArguments()` helper in the anthropic adapter.

#### OpenAI adapter refactor
Extracted duplicated payload-building logic from `chatComplete()` and `streamComplete()` into shared helpers: `applyTokenParams`, `applyStandardParams`, `applyFormatParams`, `applyToolParams`, `applyLogprobParams`. This eliminates the drift between streaming and non-streaming paths.

### Kilo Code Integration Test

Point a real Kilo Code instance at the gateway and verify:
1. Multi-turn conversation with file reads (`read_file` tool)
2. Command execution (`execute_command` tool)
3. File writes (`write_to_file` tool)
4. Streaming responses display correctly
5. Token usage appears in UI

---

## References

- OpenAI Chat Completions API: `docs/openapi.with-code-samples.yml` lines 3080-37222
- CreateChatCompletionRequest schema: line 36874
- CreateChatCompletionResponse schema: line ~37273
- ChatCompletionResponseMessage schema: line ~35483
- ChatCompletionStreamResponseDelta schema: line ~35676
- CompletionUsage schema: line ~36069
- Streaming response schema: line ~37423
