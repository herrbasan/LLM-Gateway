# LLM Gateway Adapters

## Common Features (All Adapters)

### Config-Level maxTokens Override

All chat adapters support setting a default `maxTokens` in the model config that overrides any request value:

```json
{
  "my-model": {
    "type": "chat",
    "adapter": "lmstudio",
    "endpoint": "http://localhost:12345/v1",
    "adapterModel": "Qwen/Qwen3.5-35B-A3B",
    "maxTokens": 8192,
    "capabilities": { ... }
  }
}
```

### Hard Token Cap (Safety Limit)

For models that may generate endlessly (ignoring `max_tokens`), you can set a hard cap at the gateway level. The adapter will forcibly stop the stream after this many tokens:

```json
{
  "my-model": {
    "adapter": "lmstudio",
    "maxTokens": 8192,
    "hardTokenCap": 10000,
    "capabilities": { ... }
  }
}
```

**How it works:**
- Tracks estimated tokens from streamed content
- When `hardTokenCap` is reached, yields final chunk with `finish_reason: "length"`
- Immediately terminates the stream
- Falls back to `maxTokens` if `hardTokenCap` is not set

**Use case:** Qwen models with thinking enabled may ignore `max_tokens` - use `hardTokenCap` as a safety net.

### Config-Level extraBody

All chat adapters support `extraBody` for provider-specific parameters applied to every request:

```json
{
  "my-model": {
    "adapter": "lmstudio",
    "maxTokens": 8192,
    "extraBody": {
      "chat_template_kwargs": {
        "enable_thinking": false
      }
    }
  }
}
```

### Request-Level extra_body

Per-request provider-specific parameters can also be passed:

```json
{
  "model": "my-model",
  "messages": [...],
  "extra_body": {
    "top_k": 20,
    "chat_template_kwargs": {
      "enable_thinking": false
    }
  }
}
```

Request-level `extra_body` merges with and overrides config-level `extraBody`.

---

## OpenAI Responses API Adapter

The `responses` adapter provides compatibility with OpenAI's newer Responses API (`/v1/responses`).

### Overview

The Responses API is OpenAI's most advanced interface for generating model responses. Key differences from Chat Completions API:

- Uses `input` array instead of `messages`
- Supports stateful conversations via `previous_response_id`
- Built-in tools: web_search, file_search, computer_use, code_interpreter, etc.
- Semantic streaming events (different from Chat Completions SSE format)
- Extended tool ecosystem including MCP (Model Context Protocol)

### Supported Features

| Feature | Status | Notes |
|---------|--------|-------|
| Chat completions | ✅ | Translates `messages` to `input` format |
| Streaming | ✅ | Transforms Responses API events to Chat Completions format |
| Vision | ✅ | Images converted to `input_image` type |
| Function calling | ✅ | Name, arguments, call_id mapped to standard format |
| Web search | ⚠️ | Built-in tool, events pass through in extended format |
| File search | ⚠️ | Built-in tool, events pass through in extended format |
| Computer use | ⚠️ | Supported by API, events pass through |
| Code interpreter | ⚠️ | Supported by API, events pass through |
| Stateful conversations | ✅ | `previous_response_id` support |
| Structured output | ✅ | Via `text.format` |
| Reasoning (o-series) | ✅ | `reasoning_content` and `reasoning_summary` mapped |
| Refusals | ✅ | `refusal` field in delta |
| Tool lifecycle | ✅ | `output_item.added` events for function calls |
| Config maxTokens | ✅ | Override request max_tokens at config level |
| Config extraBody | ✅ | Apply provider-specific params to all requests |
| Request extra_body | ✅ | Per-request provider-specific params |
| Embeddings | ❌ | Use `openai` adapter instead |
| Image generation | ❌ | Use `openai` adapter instead |
| TTS | ❌ | Use `openai` adapter instead |

### Streaming Event Transformation

The Responses API uses semantic event types that differ from Chat Completions. The adapter transforms these:

| Responses API Event | Chat Completions Format | Status |
|---------------------|-------------------------|--------|
| `response.output_text.delta` | `{choices: [{delta: {content: "..."}}]}` | ✅ Mapped |
| `response.function_call_arguments.delta` | `{choices: [{delta: {function_call: {arguments: "..."}}}]} | ✅ Mapped |
| `response.output_item.added` (function_call) | `{choices: [{delta: {function_call: {name, call_id}}}]} | ✅ Mapped |
| `response.reasoning_text.delta` | `{choices: [{delta: {reasoning_content: "..."}}]}` | ✅ Mapped |
| `response.reasoning_summary_text.delta` | `{choices: [{delta: {reasoning_summary: "..."}}]}` | ✅ Mapped |
| `response.refusal.delta` | `{choices: [{delta: {refusal: "..."}}]}` | ✅ Mapped |
| `response.refusal.done` | `{choices: [{delta: {refusal: "..."}}]}` | ✅ Mapped |
| `response.completed` / `response.done` | `{choices: [{finish_reason: "stop"}]}` | ✅ Mapped |
| `response.created` / `response.in_progress` | Minimal chunk with id/model | ✅ Mapped |
| `response.failed` | Error object | ✅ Mapped |
| Tool events (file_search, web_search, etc.) | Extended pass-through | ⚠️ Pass-through |
| `response.output_text.done` | null (ignored) | ✅ Handled |
| `response.function_call_arguments.done` | null (ignored) | ✅ Handled |

#### Full Event Type Reference

Core lifecycle events:
- `response.created` - Response initiated
- `response.in_progress` - Generation started
- `response.completed` - Response finished successfully
- `response.failed` - Response failed
- `error` - Error occurred

Output item events:
- `response.output_item.added` - New output item (message, function_call, etc.)
- `response.output_item.done` - Output item complete
- `response.content_part.added` - Content part added
- `response.content_part.done` - Content part complete

Text streaming:
- `response.output_text.delta` - Text token delta
- `response.output_text.done` - Final text
- `response.output_text.annotation.added` - Citation/file annotation

Function calling:
- `response.function_call_arguments.delta` - Arguments JSON delta
- `response.function_call_arguments.done` - Final arguments

Reasoning (o-series models):
- `response.reasoning_text.delta` - Reasoning text delta
- `response.reasoning_text.done` - Final reasoning
- `response.reasoning_summary_text.delta` - Summary delta
- `response.reasoning_summary.delta` - Alternative summary event

Tool-specific events:
- `response.file_search_call.*` - File search lifecycle
- `response.web_search_call.*` - Web search lifecycle
- `response.code_interpreter_call.*` - Code interpreter lifecycle
- `response.computer_call.*` - Computer use lifecycle
- `response.image_generation_call.*` - Image generation lifecycle

### Input Format Conversion

Standard chat `messages` are converted to Responses API `input` format:

```javascript
// Chat format (input)
{
  role: "user",
  content: [
    { type: "text", text: "What's in this image?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
  ]
}

// Converted to Responses format
{
  role: "user",
  content: [
    { type: "input_text", text: "What's in this image?" },
    { type: "input_image", image_url: "data:image/png;base64,..." }
  ]
}
```

### Configuration Example

```json
{
  "gpt-chat": {
    "type": "chat",
    "adapter": "responses",
    "endpoint": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "adapterModel": "gpt-5.4-mini",
    "capabilities": {
      "contextWindow": 400000,
      "vision": true,
      "streaming": true,
      "structuredOutput": true,
      "tools": true,
      "stateful": true
    }
  }
}
```

### Request Parameters

Standard parameters supported:
- `messages` or `input` - Conversation history
- `model` - Model identifier
- `stream` - Enable streaming
- `temperature`, `top_p` - Sampling parameters
- `max_tokens` / `max_output_tokens` - Output limit (see Config Override below)
- `tools` - Function definitions or built-in tools
- `tool_choice` - Tool selection mode
- `previous_response_id` - For stateful conversations
- `store` - Persist conversation state
- `metadata` - Custom metadata
- `user` - End-user identifier

Responses API-specific:
- `instructions` - System/developer instructions
- `text.format` - Structured output schema
- `reasoning` - Reasoning configuration for o-series
- `parallel_tool_calls` - Enable parallel tool execution

#### Disabling Thinking (Qwen Models)

For models like Qwen that support thinking, you can disable it at the config level:

```json
{
  "qwen-chat": {
    "type": "chat",
    "adapter": "lmstudio",
    "endpoint": "http://localhost:12345/v1",
    "adapterModel": "Qwen/Qwen3.5-35B-A3B",
    "maxTokens": 8192,
    "extraBody": {
      "chat_template_kwargs": {
        "enable_thinking": false
      }
    },
    "capabilities": {
      "contextWindow": 128000,
      "streaming": true
    }
  }
}
```

Or disable it per-request via `extra_body`:

```json
{
  "model": "qwen-chat",
  "messages": [{"role": "user", "content": "Hello"}],
  "extra_body": {
    "chat_template_kwargs": {
      "enable_thinking": false
    }
  }
}
```

Request-level `extra_body` overrides config-level `extraBody`.

The `extraBody`/`extra_body` object is spread directly into the request payload, allowing any provider-specific extensions like:
- `top_k` - Alternative sampling parameter
- `chat_template_kwargs` - Model-specific template options
- `enable_thinking` - Disable thinking mode on Qwen models

### Tools Support

Built-in tool types:
- `web_search` / `web_search_preview` - Internet search
- `file_search` - Vector store search
- `code_interpreter` - Python code execution
- `computer` / `computer_use_preview` - Computer control
- `image_generation` - GPT image generation
- `mcp` - Model Context Protocol servers

Function tools:
- Standard function calling with `type: "function"`
- Namespace support for organizing tools
- Deferred loading via tool search

### Response Format

Non-streaming responses pass through the Responses API format with `provider: "openai"` added.

Streaming responses are transformed to Chat Completions chunks for compatibility with existing clients.

### WebSocket Integration

The adapter works seamlessly with the WebSocket real-time interface:

1. **Event Flow**: Adapter yields transformed chunks → WebSocket handler iterates → Sends `chat.delta` notifications
2. **Content Extraction**: The handler extracts `choices[0].delta.content` from each chunk
3. **Progress Events**: Tool events (file_search, web_search) pass through and can be received by clients as extended events
4. **Completion**: Final `chat.done` event includes usage stats and finish reason

Example WebSocket event sequence:
```
chat.create → response (accepted) → chat.progress (routing) → chat.progress (context)
  → chat.delta {choices: [{delta: {content: "Hello"}}]}
  → chat.delta {choices: [{delta: {content: " world"}}]}
  → chat.done {finish_reason: "stop", usage: {...}}
```

Note: The first chunk may have empty `choices` (just id/model metadata) - this is normal.

### Known Limitations

1. **Embeddings**: Responses API doesn't support embeddings - use `openai` adapter
2. **Image generation**: Use `openai` adapter for DALL-E endpoints  
3. **Audio**: TTS/Whisper not supported via Responses API
4. **Tool events**: File search, web search, code interpreter, and computer use events pass through in extended format rather than Chat Completions format
5. **MCP tools**: Supported by API but events pass through untransformed
6. **Moderation**: Streaming makes content moderation more challenging

### Debugging

Enable debug logging to see raw Responses API events:
```bash
DEBUG=responses npm start
```

### References

- [OpenAI Responses API Overview](https://developers.openai.com/api/reference/responses/overview)
- [Streaming Responses Guide](https://platform.openai.com/docs/guides/streaming-responses)
- [Conversation State Guide](https://platform.openai.com/docs/guides/conversation-state)
- [Function Calling Guide](https://platform.openai.com/docs/guides/function-calling)
- [Community Streaming Events Reference](https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122)


---

## llama.cpp Adapter

The `llamacpp` adapter provides direct integration with llama.cpp's OpenAI-compatible server.

### Overview

llama.cpp is the fastest and most reliable inference engine for GGUF models. Key advantages:

- **Speed**: Optimized C++ implementation, ~5-15% faster than wrappers
- **Reliability**: Rock-solid streaming, respects all parameters
- **Memory efficient**: Excellent context management
- **GGUF native**: Direct support for quantized models

### Configuration Example

```json
{
  "llama-local": {
    "type": "chat",
    "adapter": "llamacpp",
    "endpoint": "http://localhost:12346",
    "adapterModel": "qwen3.5-35b-a3b-uncensored",
    "maxTokens": 8192,
    "hardTokenCap": 10000,
    "extraBody": {
      "stop": ["<|im_end|>"],
      "frequency_penalty": 1.5
    },
    "capabilities": {
      "contextWindow": 64000,
      "vision": false,
      "streaming": true,
      "structuredOutput": true
    }
  }
}
```

### Starting llama.cpp Server

```bash
# Basic CPU-only
llama-server -m model.gguf -c 64000 --port 12346

# With GPU acceleration (CUDA)
llama-server -m model.gguf -c 64000 -ngl 99 --port 12346

# All options
llama-server \
  -m qwen3.5-35b-a3b-uncensored.q4_k_m.gguf \
  -c 64000 \
  -ngl 99 \
  --port 12346 \
  --host 0.0.0.0
```

### Supported Parameters

Standard OpenAI-compatible parameters:
- `messages` - Conversation history
- `model` - Model identifier (must match loaded model)
- `stream` - Enable streaming
- `max_tokens` / `maxTokens` - Output limit
- `temperature`, `top_p` - Sampling parameters
- `frequency_penalty`, `presence_penalty` - Repetition penalties
- `stop` - Stop sequences

Config-level extras via `extraBody`:
- `stop` - Additional stop sequences
- `frequency_penalty` - Override penalty
- Any llama.cpp-specific parameters

### Comparison with LM Studio Adapter

| Feature | `llamacpp` | `lmstudio` |
|---------|-----------|------------|
| **Speed** | Fastest (native) | Good (wrapper) |
| **Reliability** | Excellent | Good |
| **Parameter respect** | Perfect | Sometimes ignores |
| **Multi-model** | One model per server | One model per server |
| **GUI** | None | Yes |

**Recommendation**: Use `llamacpp` for production/gateway use where reliability matters. Use `lmstudio` for interactive experimentation.

### Why Use llama.cpp?

If you experience issues with LM Studio:
- Endless generation ignoring `max_tokens`
- Thinking mode can't be disabled
- Streaming instability

Switch to llama.cpp - it respects all parameters correctly and provides the most stable inference.

---

*Generated for LLM Gateway - Fast, reliable local inference*