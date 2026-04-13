# LLM Gateway → llama-cpp-gateway Integration

## Overview

The `llama-cpp-gateway` manager is a **header-driven inference service**. The Gateway sends model configuration via `X-Model-*` headers with each request. The manager loads, swaps, and proxies automatically. No model registry, no duplication — the Gateway owns all config.

## Architecture

```
Gateway ──POST /v1/chat/completions──────────────────────────► Manager (4080)
         headers: X-Model-Path, X-Model-CtxSize, ...                  │
         body: { "model": "...", "messages": [...] }                  ▼
                                                          header match with loaded model?
                                                          same path → proxy immediately (body piped raw)
                                                          different path → stop current, start new
                                                          nothing loaded → start model from headers
                                                                             wait for /health (up to 120s)
                                                                             then proxy
                                                                          │
                                                                          ▼
Gateway ◄──────────── SSE stream (zero transformation) ◄─────────────────┘
```

## Gateway Config

The `localInference` block in the Gateway config is the **source of truth** for model configuration. The `llamacpp` adapter reads it and forwards it as `X-Model-*` headers.

### badkid-llama-chat

```json
"badkid-llama-chat": {
    "type": "chat",
    "adapter": "llamacpp",
    "disabled": false,
    "endpoint": "http://localhost:4080",
    "localInference": {
        "enabled": true,
        "modelPath": "D:/# AI Stuff/LMStudio_Models/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q3_K_M.gguf",
        "mmproj": "D:/# AI Stuff/LMStudio_Models/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive/mmproj-Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-f16.gguf",
        "contextSize": 64000,
        "gpuLayers": 99,
        "flashAttention": true,
        "mlock": true
    },
    "maxTokens": 8192,
    "hardTokenCap": 10000,
    "extraBody": {
        "stop": ["</s>"],
        "chat_template_kwargs": { "enable_thinking": true }
    },
    "imageInputLimit": {
        "maxDimension": 2048,
        "maxFileSize": 52428800,
        "supportedFormats": ["png", "jpeg", "gif", "webp"]
    },
    "capabilities": {
        "contextWindow": 64000,
        "vision": true,
        "streaming": true,
        "structuredOutput": true
    }
}
```

### badkid-llama-embed

```json
"badkid-llama-embed": {
    "type": "embedding",
    "adapter": "llamacpp",
    "disabled": false,
    "endpoint": "http://localhost:4080",
    "localInference": {
        "enabled": true,
        "modelPath": "D:/# AI Stuff/LMStudio_Models/ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
        "contextSize": 512,
        "gpuLayers": 99,
        "embedding": true,
        "pooling": "mean",
        "batchSize": 512,
        "mlock": true
    },
    "capabilities": {
        "contextWindow": 512,
        "embedding": true,
        "embeddingDimensions": 1024
    }
}
```

### Key Changes from Previous Setup

| Field | Old | New |
|-------|-----|-----|
| `endpoint` | `http://localhost:12346` | `http://localhost:4080` |
| `localInference` | ignored by old manager | **source of truth** — adapter forwards as headers |
| `adapterModel` | GGUF filename | no longer needed (model path comes from `localInference.modelPath`) |

## Header Mapping

The adapter maps `localInference` fields to headers:

| `localInference` field | Header | Example |
|------------------------|--------|---------|
| `modelPath` | `X-Model-Path` | `D:/models/Qwen-35B.gguf` |
| `contextSize` | `X-Model-CtxSize` | `64000` |
| `gpuLayers` | `X-Model-GpuLayers` | `99` |
| `flashAttention` | `X-Model-FlashAttention` | `true` |
| `mmproj` | `X-Model-Mmproj` | `D:/models/mmproj-f16.gguf` |
| `embedding` | `X-Model-Embedding` | `true` |
| `pooling` | `X-Model-Pooling` | `mean` |
| `batchSize` | `X-Model-BatchSize` | `512` |
| `mlock` | `X-Model-Mlock` | `true` |

## Startup Order

1. **Start the manager**:
   ```powershell
   node D:\DEV\llama-cpp-gateway\src\manager\server.js
   ```
2. **Start the Gateway**:
   ```powershell
   node src/main.js
   ```
3. **First inference request** → manager reads headers, starts llama-server, waits for health (~5-10s for a 35B model)
4. **Subsequent requests** → instant, model stays loaded

The manager keeps the model in VRAM until a request with a different `X-Model-Path` arrives, or until `/stop` is called.

## Adding a New Local Model

1. Add an entry to the Gateway's `config.json` with `adapter: "llamacpp"` and a `localInference` block
2. That's it. The manager needs no changes — it reads config from headers.

## Manager Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/models` | Scan models dir, return GGUF metadata (vision support, context length, etc.) |
| GET | `/health` | Health check (delegates to llama-server) |
| GET | `/status` | State + loaded model path |
| POST | `/stop` | Kill loaded model |
| Any | `/v1/*`, `/chat/*`, etc. | Inference — reads `X-Model-*` headers, auto-starts/swaps model, proxies body |

### GET /status Response

```json
{
  "state": "running",
  "pid": 12345,
  "port": 4081,
  "model": "D:/models/Qwen-35B-Q3_K_M.gguf",
  "metrics": { "raw": "..." },
  "detached": false
}
```

States: `idle`, `starting`, `running`, `error`

## Error Responses

| Status | When |
|--------|------|
| 400 | Missing `X-Model-Path` header |
| 500 | llama-server failed to start |
| 504 | Model failed to become healthy within 120s |
| 502 | llama-server crashed mid-request |

## Running as a Service

### PM2

```powershell
cd D:\DEV\llama-cpp-gateway
pm2 start src/manager/server.js --name llama-manager
pm2 save
pm2 startup
```

### Windows Task Scheduler

```powershell
$action = New-ScheduledTaskAction -Execute "node" `
    -Argument "D:\DEV\llama-cpp-gateway\src\manager\server.js" `
    -WorkingDirectory "D:\DEV\llama-cpp-gateway"
$trigger = New-ScheduledTaskTrigger -AtLogon
Register-ScheduledTask -TaskName "LlamaManager" -Action $action -Trigger $trigger -RunLevel Highest
```

### Keep Model in VRAM Across Manager Restarts

```powershell
$env:DETACH_ON_SHUTDOWN = "true"
```

With this set, stopping the manager leaves llama-server running. On next startup, the manager re-attaches automatically.
