# Multi-Model Setup with llama.cpp

You can run **multiple llama.cpp servers** simultaneously - each on its own port with its own model.

## How It Works

The `InferenceManager` tracks processes by `modelId`, so each model gets its own server:

```
Port 12346 → llama-server.exe (Chat model - 19GB VRAM)
Port 12347 → llama-server.exe (Embedding model - 1GB VRAM)
```

## VRAM Requirements

| Model | Typical Size | GPU Layers 99 | VRAM Used |
|-------|-------------|---------------|-----------|
| 7B Q4_K_M | ~4 GB | 33 layers | ~4 GB |
| 35B Q3_K_M | ~14 GB | 41 layers | ~19 GB |
| Embedding (BGE) | ~1 GB | All layers | ~1 GB |

**RTX 4090 (24GB) can run:**
- 35B chat model (19GB) + Embedding model (1GB) = 20GB ✅
- 7B chat model (4GB) + 7B coding model (4GB) + Embedding (1GB) = 9GB ✅

## Config Example

```json
{
  "llama-chat": {
    "type": "chat",
    "adapter": "llamacpp",
    "endpoint": "http://localhost:12346",
    "capabilities": { "contextWindow": 8192 },
    "localInference": {
      "enabled": true,
      "modelPath": "D:/models/chat-model.gguf",
      "contextSize": 8192,
      "gpuLayers": 99
    }
  },
  
  "llama-embed": {
    "type": "embedding",
    "adapter": "llamacpp",
    "endpoint": "http://localhost:12347",
    "capabilities": { 
      "contextWindow": 512,
      "embedding": true 
    },
    "localInference": {
      "enabled": true,
      "modelPath": "D:/models/bge-large-gguf",
      "contextSize": 512,
      "gpuLayers": 99,
      "embedding": true,
      "pooling": "mean"
    }
  }
}
```

## Embedding-Specific Options

```json
"localInference": {
  "enabled": true,
  "modelPath": "D:/models/bge-large.gguf",
  "contextSize": 512,
  "gpuLayers": 99,
  
  "//": "=== EMBEDDING OPTIONS ===",
  "embedding": true,
  "pooling": "mean"
}
```

| Option | Values | Description |
|--------|--------|-------------|
| `embedding` | `true` | Enable embedding-only mode |
| `pooling` | `none`, `mean`, `cls`, `last`, `rank` | How to pool token embeddings |

**Pooling types:**
- `mean` - Average all token embeddings (most common)
- `cls` - Use [CLS] token embedding
- `last` - Use last token embedding
- `none` - Return all token embeddings

## Good Embedding Models

| Model | Size | Dimensions | Best For |
|-------|------|------------|----------|
| **bge-large-en-v1.5** | ~1GB | 1024 | General purpose |
| **bge-base-en-v1.5** | ~400MB | 768 | Faster, smaller |
| **nomic-embed-text-v1** | ~500MB | 768 | Open source |
| **e5-mistral-7b** | ~14GB | 4096 | Best quality |

Download from: https://huggingface.co/models?search=gguf+embedding

## Auto-Start Behavior

Each server starts **on first request** to that model:

1. Chat request to `llama-chat` → Starts port 12346
2. Embedding request to `llama-embed` → Starts port 12347

Both stay running until gateway shutdown.

## Checking Status

```bash
# See all running servers
curl http://localhost:3400/v1/models

# Check specific server
curl http://localhost:12346/v1/models
curl http://localhost:12347/v1/models
```

## Memory Management Tips

### 1. Smaller Context for Embeddings
Embeddings don't need large context:
```json
"contextSize": 512  // Enough for most documents
```

### 2. CPU Offload for Embeddings
If VRAM is tight, offload embeddings to CPU:
```json
"gpuLayers": 20  // Partial offload, still fast for embeddings
```

### 3. Sequential Loading
Servers start on-demand, so VRAM is only used when needed.

## Troubleshooting

### "Port already in use"
Make sure each model has a unique port in `endpoint`.

### Out of VRAM
```
CUDA out of memory
```
Solutions:
- Reduce `gpuLayers` for one model
- Use smaller embedding model
- Close other GPU applications

### Embedding model not responding
Check it was started with `embedding: true`:
```bash
curl http://localhost:12347/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello", "model": "test"}'
```

## Full Working Example

See `config-multimodel-example.json` for a complete setup with chat + embeddings.
