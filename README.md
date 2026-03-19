# LLM Gateway v2.0

A stateless, model-centric gateway for LLM APIs. OpenAI-compatible interface with support for multiple providers.

Recent behavior of note:

- Chat requests without `max_tokens` get an automatically derived output budget based on remaining context
- Chat responses expose `context.resolved_max_tokens` and `context.max_tokens_source`
- WebSocket `chat.cancel` aborts the upstream provider request
- HTTP client disconnects abort in-flight upstream chat generation for supported adapters

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
- **Multi-provider** - Gemini, OpenAI, Ollama, LM Studio, MiniMax, Kimi
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
      "adapter": "ollama",
      "endpoint": "http://localhost:11434",
      "adapterModel": "llama3.2",
      "capabilities": {
        "contextWindow": 128000,
        "streaming": true
      }
    }
  },
  "routing": {
    "defaultChatModel": "gemini-flash"
  }
}
```

For SSE clients, closing the HTTP connection now aborts the upstream provider request instead of letting generation continue in the background.

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

## Architecture

### Model-Centric Design

Each model is independently configured with:
- **Type**: chat, embedding, image, audio
- **Adapter**: Protocol handler (gemini, openai, ollama, etc.)
- **Capabilities**: Explicit declaration (contextWindow, vision, etc.)
- **Endpoint/Auth**: Per-model configuration

### Stateless Operation

- Client sends full message history with each request
- No server-side session management
- No `X-Session-Id` header
- Automatic context compaction when needed

### Supported Adapters

| Adapter | Chat | Embeddings | Images | Audio |
|---------|------|------------|--------|-------|
| Gemini | ✅ | ✅ | ❌ | ✅ |
| OpenAI | ✅ | ✅ | ✅ | ✅ |
| Ollama | ✅ | ✅ | ❌ | ❌ |
| LM Studio | ✅ | ✅ | ❌ | ❌ |
| MiniMax | ✅ | ❌ | ❌ | ❌ |
| Kimi Code | ✅ | ❌ | ❌ | ❌ |

## API Documentation

See [docs/api_documentation.md](docs/api_documentation.md) for complete API reference.

- REST/OpenAI-compatible reference: [docs/api_rest.md](docs/api_rest.md)
- WebSocket real-time reference: [docs/api_websocket.md](docs/api_websocket.md)

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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GROK_API_KEY` | xAI Grok API key |
| `GLM_API_KEY` | GLM API key |
| `QWEN_API_KEY` | Qwen API key |
| `MINIMAX_API_KEY` | MiniMax API key |
| `CORS_ORIGINS` | Comma-separated allowed origins |

## License

ISC
