# LLM Gateway v2.0

A stateless, model-centric gateway for LLM APIs. OpenAI-compatible interface with support for multiple providers, including local inference via llama.cpp.

## Recent Behavior of Note

- Chat requests without `max_tokens` get an automatically derived output budget based on remaining context
- Chat responses expose `context.resolved_max_tokens` and `context.max_tokens_source`
- WebSocket `chat.cancel` aborts the upstream provider request
- HTTP client disconnects abort in-flight upstream chat generation for supported adapters
- Local llama.cpp models auto-start on first request and stay loaded in VRAM
- Task-based query system for semantic routing with preset parameters (`task` param in request body)

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
- **Multi-provider** - Gemini, OpenAI, Anthropic, Ollama, LM Studio, llama.cpp, MiniMax, Kimi, Alibaba
- **Local Inference** - Auto-managed llama.cpp servers for running GGUF models locally
- **Stateless** - No server-side session management
- **Model-centric config** - Each model configured independently
- **Context compaction** - Automatic context window management
- **Generation cancellation** - WebSocket cancellation and HTTP disconnect abort propagation

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
      "endpoint": "http://localhost:12346",
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
        "flashAttention": "on",
        "mlock": true,
        "noClearIdle": true,
        "sleepIdleSeconds": -1
      }
    }
  },
  "routing": {
    "defaultChatModel": "gemini-flash"
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
      "model": "minimax-chat",
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
- **Type**: chat, embedding, image, audio
- **Adapter**: Protocol handler (gemini, openai, llamacpp, etc.)
- **Capabilities**: Explicit declaration (contextWindow, vision, etc.)
- **Endpoint/Auth**: Per-model configuration
- **Local Inference**: For running GGUF models locally (llama.cpp)

### Stateless Operation

- Client sends full message history with each request
- No server-side session management
- No `X-Session-Id` header
- Automatic context compaction when needed

### Supported Adapters

| Adapter | Chat | Embeddings | Images | Audio | Vision | Local |
|---------|------|------------|--------|-------|--------|-------|
| Gemini | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| OpenAI | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Anthropic | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Ollama | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| LM Studio | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| **llama.cpp** | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| MiniMax | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Kimi | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Alibaba | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| OpenAI Responses | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |

### Local Inference with llama.cpp

The gateway can auto-manage local llama.cpp servers:

1. Place `llama-server.exe` and CUDA DLLs in `inference/` folder
2. Configure with `localInference.enabled: true`
3. Server starts on first request, stays loaded in VRAM
4. Supports multiple models on different ports

**Key options:**
- `modelPath` - Path to GGUF file
- `mmproj` - Path to multimodal projector (for vision)
- `gpuLayers` - Number of layers to offload to GPU (99 = all)
- `flashAttention` - Enable Flash Attention ("on"/"off"/"auto")
- `mlock` - Keep model in RAM
- `noClearIdle` + `sleepIdleSeconds: -1` - Stay loaded forever

## API Documentation

- [REST API Reference](docs/api_rest.md) - Standard OpenAI-compatible HTTP endpoints
- [WebSocket API Reference](docs/api_websocket.md) - Real-time active connection protocol

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
| No local inference | Auto-managed llama.cpp support |

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
