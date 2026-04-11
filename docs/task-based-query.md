# Task-Based Query System

The LLM Gateway now supports **task-based queries**. Instead of specifying a model and tuning parameters for every request, you can now reference a named task that encapsulates the model choice, system prompt, temperature, max tokens, and other defaults.

## Usage

### HTTP

```json
POST /v1/chat/completions
{
  "task": "query",
  "messages": [{"role": "user", "content": "..."}]
}
```

### WebSocket

```json
{
  "method": "chat.create",
  "params": {
    "task": "query",
    "messages": [{"role": "user", "content": "..."}]
  }
}
```

## Available Tasks

| Task | Description |
|------|-------------|
| `query` | General query and conversation |
| `inspect` | Code inspection and analysis |
| `synthesis` | Content synthesis and summarization |
| `analysis` | Deep analysis and reasoning |
| `embed` | Text embedding generation |
| `vision` | Image understanding and visual analysis |
| `image` | Image generation from text prompts |
| `tts` | Text-to-speech synthesis |

## Key Points

- **Client parameters always override task defaults** — you can still customize per-request
- **List available tasks** with `GET /v1/tasks`
- **Works across all endpoints** — chat, embeddings, image generation, and audio
- **Centralized routing** — no need for each service to maintain its own model selection logic

## Why Use Tasks?

This replaces the need for each service to maintain its own model routing logic — the gateway now handles it centrally. Define your tasks once in `config.json`, and all clients simply reference them by name.
