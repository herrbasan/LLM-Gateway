# LLM Gateway

**Centralized LLM service with transparent context-window management and multi-provider routing.**

The **LLM Gateway** is a centralized, OpenAI-compatible service that transparently routes requests and mitigates context window limitations for massive text inputs. It supports fallback precedence routing, structured output limitation blocks, stateful sessions, and advanced metrics to protect your downstream local or remote endpoints from large contexts, enforcing load bounds efficiently.

---

## Features

- **OpenAI-Compatible HTTP API** - Seamlessly works with existing OpenAI SDKs (standard `200` responses by default).
- **Multi-Provider Routing** - First-class adapter support for LM Studio, Ollama, Gemini, OpenAI, Kimi, and Minimax. Note: Grok, GLM, and Qwen can be connected via the generic OpenAI adapter.
- **Unified Streaming Architecture** - Manages keep-alives via `heartbeat`, efficiently tracks Node backpressure limits with sliding window buffers (`drain` handler), and outputs standard OpenAI SSE streaming.
- **Context Mitigation Strategies** - Enforces `truncate`, `compress`, and `rolling` reduction behaviors on large inputs transparently to prevent downstream `413 Payload Too Large` errors.
- **Multimodal Media Endpoints (Phase 2)** - Supports `POST /v1/images/generations` (forced async ticket workflow) and `POST /v1/audio/speech` (synchronous binary TTS).
- **Temporary Media Staging & Eviction** - Generated media can be staged under `/v1/media/*` with TTL cleanup to prevent disk growth.
- **Stateful Sessions** - `SessionStore` utilizing in-memory TTL with sliding windows tracking multi-turn context (1hr default TTL).
- **Intelligent Embeddings Routing** - Standardized `/v1/embeddings` endpoint with batch request wrappers and automatic fallback.
- **Resilience & Production Hardened** - Built-in Circuit Breakers protecting adapted endpoints with exponential backoff and `/health` reporting. Heavily load-tested against multi-gigabyte concurrent workloads without memory exhaustion.

---

## Quick Start (Local Development)

### Requirements
- Node.js (v20+ recommended)
- Standard environment configured via `.env` (Optional but recommended)

### Setup

```bash
# 1. Install Dependencies
npm install

# 2. Configure Settings
cp config.example.json config.json

# 3. Add any necessary credentials in .env
# Example: GEMINI_API_KEY=your_key_here

# 4. Start the Application
npm start
# Service runs by default on http://localhost:3400
```

### Running Tests

```bash
# Unit tests (no server required)
npm test

# Integration tests (requires running server)
npm run test:integration

# Provider tests (tests all configured providers)
npm run test:providers

# All tests
npm run test:all
```

---

## Docker Deployment (Production)

The LLM Gateway is designed to be easily containerized and runs efficiently in isolated environments.

### Option 1: Using Docker Compose (Recommended)

Included is a `docker-compose.yml` for quick and reproducible setups.

1. Ensure Docker and Docker Compose are installed.
2. Edit or supply your `config.json` in the root folder (or map it via `docker-compose.yml` volumes).
3. If using local LLM providers like Ollama running on your host machine, you may map endpoints inside your configuration to `http://host.docker.internal:11434`.
4. Run:
```bash
docker-compose up -d --build
```

### Option 2: Building the Image Manually

To manually build and run the Docker image without Compose:

```bash
# Build the Docker image
docker build -t llm-gateway .

# Run the container (Mapping port 3400 and injecting typical ENV vars)
docker run -d \
  --name llm-gateway \
  -p 3400:3400 \
  -e NODE_ENV=production \
  -e GEMINI_API_KEY=your_key \
  llm-gateway
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [API Documentation](./docs/api_documentation.md) | Complete API reference, endpoint details, response patterns, and usage examples |
| [Developer Notes](./docs/dev-notes.md) | Architecture, project structure, adapter development, and technical implementation details |

---

## Configuration Guide

The `config.json` supports environment variable substitution automatically. For instance, putting `${MY_KEY}` in the JSON file will evaluate `process.env.MY_KEY` at runtime.

Providers and specific fallback routing rules are declared directly inside `config.json`. Refer to the `config.example.json` to review structure configurations.

### Quick Configuration Example

```json
{
  "port": 3400,
  "routing": {
    "defaultProvider": "lmstudio"
  },
  "mediaStorage": {
    "enabled": true,
    "ttlMinutes": 60,
    "cleanupIntervalMs": 60000
  },
  "providers": {
    "lmstudio": {
      "type": "lmstudio",
      "endpoint": "http://localhost:1234",
      "model": "qwen2.5-14b",
      "capabilities": {
        "embeddings": true,
        "structuredOutput": true,
        "streaming": true,
        "imageGeneration": false,
        "tts": false,
        "stt": false
      }
    }
  }
}
```

---

## Supported Providers

| Provider | Type | Embeddings | Streaming | Structured Output | Image Gen | TTS |
|----------|------|------------|-----------|-------------------|-----------|-----|
| Gemini | `gemini` | ✅ | ✅ | ✅ | Configurable | Configurable |
| LM Studio | `lmstudio` | ✅ | ✅ | ✅ | Configurable | Configurable |
| Ollama | `ollama` | ✅ | ✅ | ❌ | Configurable | Configurable |
| OpenAI | `openai` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Grok (xAI) | `openai` | ❌ | ✅ | ✅ | Configurable | Configurable |
| GLM | `openai` | ❌ | ✅ | ✅ | Configurable | Configurable |
| MiniMax | `minimax` | ❌ | ❌ | ✅ | Configurable | Configurable |
| Kimi | `kimi-cli` | ❌ | Simulated | ❌ | ❌ | ❌ |
| Qwen | `openai` | ❌ | ✅ | ✅ | Configurable | Configurable |

See [Provider Adapters Documentation](./src/adapters/adapters.md) for detailed configuration of each provider.

---

## License

MIT
