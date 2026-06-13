# LLM Gateway v2.0

A stateless, model-centric gateway for LLM APIs. OpenAI-compatible interface with support for multiple providers, including local inference via llama.cpp.

## Recent Behavior of Note

- Chat requests without `max_tokens` fall back to the model's declared `capabilities.maxOutputTokens`; OpenAI-spec responses are not extended with gateway metadata
- WebSocket `chat.cancel` aborts the upstream provider request
- HTTP client disconnects abort in-flight upstream chat generation for supported adapters
- Task-based query system for semantic routing with preset parameters (`task` param in request body)
- Stateless by design — context management is the client's responsibility
- OpenAI Responses API support via `POST /v1/responses`
- Video generation via `POST /v1/videos/generations`
- Binary media uploads over WebSocket with `gateway-media://` URL scheme
- Admin endpoints for config management with hot-reload (`GET /config`, `POST /config/store`)
- Queryable structured logs via `GET /logs`

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

- **OpenAI-compatible API** - Drop-in replacement for OpenAI client libraries
- **OpenAI Responses API** - Proxy support for the newer Responses API format
- **Tool Use / Function Calling** - OpenAI-spec compliant `tools`, `tool_choice`, `parallel_tool_calls` across all adapters
- **Multi-provider** - Gemini, OpenAI, Anthropic, Ollama, LM Studio, llama.cpp, Kimi, Alibaba Cloud
- **Stateless** - No server-side session management
- **Model-centric config** - Each model configured independently
- **Generation cancellation** - WebSocket cancellation and HTTP disconnect abort propagation
- **Media processing** - Image fetching with SSRF protection, optional resize/transcode
- **Binary WebSocket** - Media uploads and audio streaming over WebSocket

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
      "adapter": "llamacpp",
      "endpoint": "http://localhost:4080",
      "adapterModel": "my-local-model",
      "capabilities": {
        "contextWindow": 8192,
        "vision": true,
        "streaming": true
      },
      "localInference": {
        "enabled": true,
        "modelPath": "/path/to/model.gguf",
        "mmproj": "/path/to/mmproj.gguf",
        "contextSize": 8192,
        "gpuLayers": 99,
        "flashAttention": true,
        "mlock": true
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
| `hardTokenCap` | Safety limit - forcibly stops generation after N tokens |
| `extraBody` | Config-level provider-specific parameters applied to all requests |
| `extra_body` | Request-level provider-specific parameters (per-request override) |
| `imageInputLimit` | Per-model image dimension and size limits |
| `localInference` | llama.cpp server configuration (model path, GPU layers, etc.) |

### Model Types

| Type | Description |
|------|-------------|
| `chat` | Chat completion models |
| `embedding` | Text embedding models |
| `image` | Image generation models |
| `audio` | Audio/speech synthesis models |
| `video` | Video generation models |

### WebSocket Cancellation

```json
{
  "jsonrpc": "2.0",
  "method": "chat.cancel",
  "params": {
    "request_id": "req-123"
  }
}
```

The server completes the cancelled stream with `chat.done` and `cancelled: true`.

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
- **Type**: chat, embedding, image, audio, video
- **Adapter**: Protocol handler (gemini, openai, llamacpp, etc.)
- **Capabilities**: Explicit declaration (contextWindow, vision, etc.)
- **Endpoint/Auth**: Per-model configuration
- **Local Inference**: For running GGUF models locally (llama.cpp)

### Stateless Operation

- Client sends full message history with each request
- No server-side session management
- No `X-Session-Id` header
- Context management is the client's responsibility

### Supported Adapters

| Adapter | Chat | Embeddings | Images | Audio | Video | Vision | Local |
|---------|------|------------|--------|-------|-------|--------|-------|
| Gemini | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| OpenAI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Anthropic | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Ollama | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| LM Studio | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **llama.cpp** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Kimi | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Alibaba | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| DashScope | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| OpenAI Responses | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

### Local Inference with llama.cpp

The gateway routes to external llama.cpp servers via the `llamacpp` adapter. The gateway does not manage `llama-server.exe` processes itself — configure an external llama.cpp server and point the adapter to its endpoint.

**Config Example:**
```json
"llama-chat": {
  "adapter": "llamacpp",
  "endpoint": "http://localhost:4080",
  "capabilities": { "contextWindow": 64000, "vision": true },
  "localInference": {
    "enabled": true,
    "modelPath": "D:/models/chat-model.gguf",
    "mmproj": "D:/models/mmproj-f16.gguf",
    "contextSize": 64000,
    "gpuLayers": 99,
    "flashAttention": true,
    "mlock": true
  }
}
```

## API Documentation

- [REST API Reference](documentation/api_rest.md) - Standard OpenAI-compatible HTTP endpoints
- [WebSocket API Reference](documentation/api_websocket.md) - Real-time active connection protocol

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
| No local inference | llama.cpp adapter support |
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
