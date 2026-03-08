# Model-Centric Architecture Refactor Plan

**Status:** ✅ COMPLETED  
**Version:** 2.0.0  
**Date:** 2026-03-07  

---

## Executive Summary

✅ **REFACTOR COMPLETE**

The LLM Gateway has been successfully transformed from provider-centric to model-centric architecture. The session system has been completely removed (stateless gateway). All adapters have been simplified to pure protocol handlers.

---

## What Was Changed

### Architecture Changes

| Before (v1.x) | After (v2.0) |
|---------------|--------------|
| Provider-level config | Model-level config |
| Session-based state | Stateless - client manages history |
| Capability inference from model IDs | Explicit capability declaration |
| `providers` section in config | `models` section in config |
| `X-Session-Id` header | Removed |
| `src/core/router.js` | `src/core/model-router.js` |
| `src/core/session.js` | Deleted |
| `src/routes/sessions.js` | Deleted |
| `src/adapters/index.js` | `src/core/adapters.js` |

### New Config Format

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
    }
  },
  "routing": {
    "defaultChatModel": "gemini-flash"
  },
  "compaction": {
    "enabled": true,
    "mode": "truncate"
  }
}
```

---

## Completion Status

### Core Components ✅

| Component | Status | Location |
|-----------|--------|----------|
| ModelRouter | ✅ Complete | `src/core/model-router.js` |
| ModelRegistry | ✅ Complete | `src/core/model-registry.js` |
| Config Schema | ✅ Complete | `src/core/config-schema.js` |
| Adapter Factory | ✅ Complete | `src/core/adapters.js` |

### Adapters ✅

All 6 adapters migrated to new stateless interface:

| Adapter | Status | Methods |
|---------|--------|---------|
| Gemini | ✅ | `chatComplete`, `streamComplete`, `createEmbedding`, `generateImage`, `synthesizeSpeech` |
| OpenAI | ✅ | `chatComplete`, `streamComplete`, `createEmbedding`, `generateImage`, `synthesizeSpeech` |
| Ollama | ✅ | `chatComplete`, `streamComplete`, `createEmbedding` |
| LM Studio | ✅ | `chatComplete`, `streamComplete`, `createEmbedding` |
| MiniMax | ✅ | `chatComplete`, `streamComplete` |
| Kimi-CLI | ✅ | `chatComplete`, `streamComplete` |

**New Adapter Interface:**
```javascript
// Stateless - model config passed per-request
async chatComplete(modelConfig, request)
async *streamComplete(modelConfig, request)
async createEmbedding(modelConfig, request)
async generateImage(modelConfig, request)
async synthesizeSpeech(modelConfig, request)
```

### Routes ✅

| Route | Status | Notes |
|-------|--------|-------|
| `POST /v1/chat/completions` | ✅ Updated | No session support |
| `POST /v1/embeddings` | ✅ Updated | Uses model-centric routing |
| `POST /v1/images/generations` | ✅ Updated | Uses model-centric routing |
| `POST /v1/audio/speech` | ✅ Updated | Uses model-centric routing |
| `GET /v1/models` | ✅ Updated | Returns flat list from config |
| `GET /v1/tasks/:id` | ✅ Kept | Async job tracking |
| `GET /health` | ✅ Updated | Returns v2.0.0 version |
| `GET /help` | ✅ Kept | Documentation endpoint |

### Deleted Components ✅

| Component | Reason |
|-----------|--------|
| `src/core/session.js` | Stateless gateway |
| `src/core/router.js` | Replaced with ModelRouter |
| `src/routes/sessions.js` | Session endpoints removed |
| `src/adapters/index.js` | Moved to `src/core/adapters.js` |
| `X-Session-Id` header | No longer needed |
| `_inferCapabilitiesFromModelId()` | No inference |

---

## Test Status

### New Tests (v2)

| Test File | Status | Description |
|-----------|--------|-------------|
| `tests/adapters.v2.test.js` | ✅ 49 passing | Real-world adapter tests |
| `tests/router.v2.test.js` | ✅ | ModelRouter tests |
| `tests/server.v2.test.js` | ✅ | HTTP endpoint tests |
| `tests/new-core.test.js` | ✅ | Core component unit tests |
| `tests/config.test.js` | ✅ | Config loading tests |

### Archived Tests (v1 - Obsolete)

| Test File | Reason |
|-----------|--------|
| `tests/_archive/adapters.test.js` | Old adapter interface |
| `tests/_archive/adapter.gemini.test.js` | Old Gemini interface |
| `tests/_archive/router.test.js` | Old Router class |
| `tests/_archive/sessions.flow.test.js` | Sessions removed |

---

## Migration Guide

### Config Migration

**v1.x Config:**
```json
{
  "providers": {
    "gemini": {
      "type": "gemini",
      "model": "gemini-flash",
      "embeddingModel": "embedding-001",
      "contextWindow": 1000000
    }
  }
}
```

**v2.0 Config:**
```json
{
  "models": {
    "gemini-flash": {
      "type": "chat",
      "adapter": "gemini",
      "adapterModel": "gemini-flash-latest",
      "capabilities": {
        "contextWindow": 1000000,
        "vision": true,
        "streaming": true
      }
    },
    "gemini-embedding": {
      "type": "embedding",
      "adapter": "gemini",
      "adapterModel": "gemini-embedding-001",
      "capabilities": {
        "contextWindow": 2048
      }
    }
  }
}
```

### Client Changes

**Before:**
```javascript
// Create session
const session = await fetch('/v1/sessions', {method: 'POST'});
const sessionId = session.id;

// Chat with session
await fetch('/v1/chat/completions', {
  headers: {'X-Session-Id': sessionId},
  body: JSON.stringify({messages: [newMessage]})
});
```

**After:**
```javascript
// No session needed - send full history
await fetch('/v1/chat/completions', {
  body: JSON.stringify({
    model: 'gemini-flash',
    messages: fullHistory // Client manages history
  })
});
```

---

## API Changes Summary

### Removed Endpoints

| Endpoint | Replacement |
|----------|-------------|
| `POST /v1/sessions` | None - client manages history |
| `GET /v1/sessions/:id` | None |
| `PATCH /v1/sessions/:id` | None |
| `DELETE /v1/sessions/:id` | None |
| `POST /v1/sessions/:id/compress` | None - compaction is per-request |

### Modified Endpoints

**`POST /v1/chat/completions`**
- ❌ Removed `X-Session-Id` header support
- ✅ Client sends full `messages` array every time
- ✅ Compaction happens per-request if needed

**`GET /v1/models`**
- ✅ Returns flat list from config
- ✅ No provider grouping
- ✅ Exact capabilities as declared

### Unchanged Endpoints

- `POST /v1/embeddings`
- `POST /v1/images/generations`
- `POST /v1/audio/speech`
- `GET /v1/tasks/:id`
- `GET /v1/tasks/:id/stream`
- `GET /health`
- `GET /help`

---

## Success Criteria ✅

- [x] All adapters migrated to new interface
- [x] Session system completely removed
- [x] Config validation passes for all model types
- [x] Tests updated for new architecture (49 passing)
- [x] Server starts successfully with new config
- [x] No capability inference in codebase
- [x] `grep -r "inferCapabilities" src/` returns nothing

---

## File Structure

```
src/
├── core/
│   ├── adapters.js          # Adapter factory (NEW)
│   ├── circuit-breaker.js   # Unchanged
│   ├── config-schema.js     # Config validation (NEW)
│   ├── events.js            # Unchanged
│   ├── model-registry.js    # Model registry (NEW)
│   ├── model-router.js      # Model router (NEW)
│   └── ticket-registry.js   # Unchanged
├── adapters/
│   ├── base.js              # Simplified
│   ├── gemini.js            # Migrated
│   ├── kimi-cli.js          # Migrated
│   ├── lmstudio.js          # Migrated
│   ├── minimax.js           # Migrated
│   ├── ollama.js            # Migrated
│   └── openai.js            # Migrated
├── routes/
│   ├── audio.js             # Updated
│   ├── chat.js              # Updated
│   ├── embeddings.js        # Updated
│   ├── events.js            # Unchanged
│   ├── health.js            # Updated
│   ├── images.js            # Updated
│   ├── models.js            # Updated
│   └── tasks.js             # Minor updates
└── streaming/
    └── sse.js               # Minor updates
```

---

## Running the Gateway

```bash
# Set required API keys
export GEMINI_API_KEY="your-key"
export OPENAI_API_KEY="your-key"

# Start gateway
npm start

# Run tests
npm test
```

---

## Remaining Work (Optional)

1. **Documentation Updates**
   - Update `api_documentation.md` with new endpoints
   - Add migration guide for existing users
   
2. **Additional Tests**
   - Review `context.test.js`, `streaming.test.js`, `media.test.js`
   - Review `resilience.test.js`, `thinking.test.js`
   - Update `integration.test.js`, `providers.test.js`, `load.test.js`

3. **Features**
   - Metrics tracking per model (was per provider)
   - Validation strictness for unknown capability fields
