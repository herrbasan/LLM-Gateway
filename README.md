# LLM Gateway v2.0

A stateless, model-centric gateway for LLM APIs. OpenAI-compatible REST interface with support for multiple providers, including local inference via llama.cpp (through its OpenAI-compatible server).

## Behavior of Note

- Chat requests without `max_tokens` fall back to the model's declared `capabilities.maxOutputTokens`; OpenAI-spec responses are not extended with gateway metadata
- HTTP client disconnects abort in-flight upstream chat generation for fetch-based chat adapters
- Task-based query system for semantic routing with preset parameters (`task` param in request body)
- Stateless by design — context management is the client's responsibility
- OpenAI Responses API support via `POST /v1/responses`
- Admin endpoints for config management with hot-reload (`GET /config`, `POST /config/store`)
- Queryable structured logs via `GET /logs`, runtime log-level control via `/logs/level`
- Per-request reasoning control: `enable_thinking` and `reasoning_effort` with per-model `thinkingLevels` declaration

> The WebSocket transport was removed on 2026-07-26. The gateway is REST/SSE only.

## Quick Start

```bash
# Install dependencies
npm install

# Configure - copy example and edit with your API keys
cp config.example.json config.json

# Start server
npm start
```

The gateway runs on `http://localhost:3400` by default.

## What This Is

LLM Gateway provides a unified interface to multiple LLM providers:

- **OpenAI-compatible API** — Drop-in replacement for OpenAI client libraries
- **OpenAI Responses API** — Proxy support for the newer Responses API format
- **Tool Use / Function Calling** — OpenAI-spec compliant `tools`, `tool_choice`, `parallel_tool_calls` across adapters
- **Multi-provider** — Any provider speaking Gemini, OpenAI-compatible, Anthropic, or OpenAI Responses protocols (Gemini, OpenAI, xAI, Anthropic, Kimi, DeepSeek, GLM/z.ai, llama.cpp, LM Studio, Ollama, ...)
- **Stateless** — No server-side session management
- **Model-centric config** — Each model configured independently with explicit capabilities
- **Generation cancellation** — HTTP disconnect aborts the upstream request
- **Media processing** — Image fetching with SSRF protection, optional resize/transcode

## Configuration

Define models in `config.json`:

```json
{
  "models": {
    "gemini-flash": {
      "type": "chat",
      "adapter": "gemini",
      "endpoint": "https://generativelanguage.googleapis.com/v1beta",
      "apiKey": "${GEMINI_API_KEY}",
      "adapterModel": "gemini-2.0-flash-001",
      "capabilities": {
        "contextWindow": 1048576,
        "vision": true,
        "structuredOutput": "json_schema",
        "streaming": true
      }
    },
    "local-llama": {
      "type": "chat",
      "adapter": "openai",
      "endpoint": "http://localhost:4080/v1",
      "adapterModel": "publisher/model-name",
      "capabilities": {
        "contextWindow": 128000,
        "vision": true,
        "streaming": true,
        "thinking": "chat_template_kwargs"
      }
    }
  },
  "tasks": {
    "query": {
      "model": "gemini-flash",
      "description": "General query and conversation",
      "maxTokens": 4096,
      "temperature": 0.7,
      "default": true
    }
  }
}
```

### Model Features

| Feature | Description |
|---------|-------------|
| `disabled` | Set `true` to temporarily disable a model without removing it from config |
| `extraBody` | Config-level provider-specific parameters applied to all requests |
| `extra_body` | Request-level provider-specific parameters (per-request override) |
| `imageInputLimit` | Per-model image dimension and size limits |
| `capabilities.maxOutputTokens` | Output token budget used when the client omits `max_tokens` (required for Anthropic-adapter models) |
| `capabilities.thinking` | `"chat_template_kwargs"` gates `enable_thinking` passthrough for OpenAI-adapter models |
| `capabilities.thinkingLevels` | Declared `reasoning_effort` values the model accepts (see Thinking Control) |

### Model Types

| Type | Description |
|------|-------------|
| `chat` | Chat completion models |
| `embedding` | Text embedding models |

## Usage

### Chat Completions

```bash
curl http://localhost:3400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-flash",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

### Streaming

```bash
curl http://localhost:3400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-flash",
    "messages": [{"role": "user", "content": "Count to 5"}],
    "stream": true
  }'
```

### Embeddings

```bash
curl http://localhost:3400/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "embedding-model",
    "input": "Text to embed"
  }'
```

### Task-Based Queries

Instead of specifying a model, use a named task with preset parameters:

```bash
curl http://localhost:3400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "task": "query",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Tasks define model selection, system prompts, temperature, max tokens, and other defaults. Client parameters override task defaults. List available tasks with `GET /v1/tasks`.

**Task config example:**
```json
{
  "tasks": {
    "query": {
      "model": "gemini-flash",
      "description": "General query and conversation",
      "maxTokens": 4096,
      "temperature": 0.7
    }
  }
}
```

## Architecture

### Model-Centric Design

Each model is independently configured with:
- **Type**: chat, embedding
- **Adapter**: Protocol handler (`gemini`, `openai`, `anthropic`, `responses`)
- **Capabilities**: Explicit declaration (contextWindow, vision, thinking, excludeParams, ...)
- **Endpoint/Auth**: Per-model configuration

### Stateless Operation

- Client sends full message history with each request
- No server-side session management
- No `X-Session-Id` header
- Context management is the client's responsibility

### Supported Adapters

| Adapter | Description | Chat | Embeddings |
|---------|-------------|------|------------|
| `openai` | Standard OpenAI Chat Completions API | ✅ | ✅ |
| `responses` | OpenAI Responses API (newer format) | ✅ | ❌ |
| `anthropic` | Anthropic Messages API (also Kimi, DeepSeek, MiniMax, GLM Anthropic endpoints) | ✅ | ❌ |
| `gemini` | Google Gemini (chat via Interactions API, embeddings via generateContent) | ✅ | ✅ |

Only these four adapters are registered and validated. A config naming any other adapter fails validation at startup.

Local inference (llama.cpp, LM Studio, Ollama) is reached through the `openai` adapter — those servers expose OpenAI-compatible APIs. See [config.example.json](config.example.json) for a llama.cpp example.

### Thinking Control

Per-request reasoning control resolves to two normalized fields:

- **`enable_thinking`** (boolean) — on/off. Adapter translation:
  - `openai` → `chat_template_kwargs.enable_thinking` (only if `capabilities.thinking === "chat_template_kwargs"`)
  - `gemini` → `generation_config.thinking_level` (`high`/`minimal`)
  - `anthropic` → `thinking` block
  - `responses` → `reasoning.effort`
- **`reasoning_effort`** (enum) — graduated effort (`minimal|low|medium|high|xhigh|max`). The router validates against the model's declared `capabilities.thinkingLevels`; undeclared values are mapped to the nearest declared level (logged). Models without `thinkingLevels` drop the field with a warning.

See the [REST API reference](documentation/api_rest.md#thinking-control) for the full resolution priority and per-adapter details.

## API Documentation

- [REST API Reference](documentation/api_rest.md) — Standard OpenAI-compatible HTTP endpoints (also served at `/help` on a running gateway)

## Development

```bash
# Run tests
npm test

# Run specific test file
npx mocha tests/new-core.test.js

# Development mode with auto-restart
npm run dev
```

## Key Differences from v1.x

| v1.x | v2.0 |
|------|------|
| Provider-centric config | Model-centric config |
| Session-based (`X-Session-Id`) | Stateless |
| Capability inference from model IDs | Explicit capabilities |
| `providers` in config | `models` in config |
| WebSocket transport | REST/SSE only |
| Per-provider adapters (kimi, alibaba, llamacpp, ...) | Four protocol adapters; providers are endpoint config |
| Server-side context compaction | Client-owned context management |
| No admin endpoints | Config hot-reload and queryable logs |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GROK_API_KEY` | xAI Grok API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `KIMI_API_KEY` | Kimi API key |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| `LOG_RETENTION_DAYS` | Days to keep log files (default: 1) |

## License

ISC
