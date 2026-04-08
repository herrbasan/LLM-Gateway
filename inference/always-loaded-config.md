# Always-Loaded Models (LMStudio-Style)

By default, llama.cpp servers start on first request and **stay running indefinitely** (no TTL). The model remains in VRAM until the gateway shuts down.

## Default Behavior (No Action Needed)

```json
"llama-chat": {
  "localInference": {
    "enabled": true,
    "modelPath": "D:/models/model.gguf"
    // Server starts on first request, stays loaded forever
  }
}
```

**What happens:**
1. First request → Server starts, model loads to VRAM (~5-10 sec)
2. All subsequent requests → Instant response (model already loaded)
3. Gateway shutdown → Server stops, VRAM freed

## Keep-Alive Options

If you want to be explicit or prevent any future idle features:

```json
"localInference": {
  "enabled": true,
  "modelPath": "D:/models/model.gguf",
  
  "//": "=== KEEP MODEL LOADED ===",
  "noClearIdle": true,
  "sleepIdleSeconds": 0
}
```

| Option | Effect |
|--------|--------|
| `noClearIdle: true` | Don't clear idle slots when new task arrives |
| `sleepIdleSeconds: 0` | Never sleep due to inactivity |

## Multiple Always-Loaded Models

```json
{
  "llama-chat": {
    "type": "chat",
    "adapter": "llamacpp",
    "endpoint": "http://localhost:12346",
    "localInference": {
      "enabled": true,
      "modelPath": "D:/models/Qwen-35B.gguf",
      "gpuLayers": 99,
      "noClearIdle": true
    }
  },
  
  "llama-embed": {
    "type": "embedding",
    "adapter": "llamacpp",
    "endpoint": "http://localhost:12347",
    "localInference": {
      "enabled": true,
      "modelPath": "D:/models/bge-large.gguf",
      "gpuLayers": 99,
      "embedding": true,
      "noClearIdle": true
    }
  }
}
```

**Both models stay in VRAM permanently** (until gateway restart).

## Pre-Loading at Startup

Want servers to start **immediately** when gateway starts (not on first request)?

Add a health check call to your startup script:

```javascript
// In gateway startup, after server is ready:
fetch('http://localhost:12346/v1/models')
  .then(() => console.log('Chat model pre-loaded'))
  .catch(() => console.log('Chat model will load on first request'));

fetch('http://localhost:12347/v1/models')
  .then(() => console.log('Embed model pre-loaded'))
  .catch(() => console.log('Embed model will load on first request'));
```

Or just send a dummy request after gateway starts:
```bash
# Pre-load chat model
curl -s http://localhost:12346/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"test","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null

# Pre-load embedding model  
curl -s http://localhost:12347/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input":"test","model":"test"}' > /dev/null
```

## VRAM Considerations

**Always-loaded = VRAM permanently used**

| Setup | VRAM Used | Comment |
|-------|-----------|---------|
| 35B chat + BGE-large | ~20 GB | Fits in RTX 4090 24GB ✅ |
| 7B chat + 7B code + BGE | ~9 GB | Fits easily ✅ |
| 70B model | ~40 GB | Won't fit 24GB ❌ |

If you run out of VRAM:
- Reduce `gpuLayers` (partial CPU offload)
- Use smaller models
- Only load models on-demand (remove `noClearIdle`)

## Checking Loaded Models

```bash
# See running processes
nvidia-smi

# See gateway-managed servers
curl http://localhost:3400/v1/models

# Check specific endpoints
curl http://localhost:12346/v1/models
curl http://localhost:12347/v1/models
```

## Differences from LMStudio

| Feature | LMStudio | llama.cpp (this setup) |
|---------|----------|----------------------|
| Auto-start | On app launch | On first request (or pre-load) |
| Stay loaded | Yes | Yes (with `noClearIdle`) |
| VRAM usage | Permanent | Permanent |
| Multiple models | Yes | Yes (each on own port) |
| GUI | Yes | No (headless) |

**Essentially the same behavior**, just without the GUI!
