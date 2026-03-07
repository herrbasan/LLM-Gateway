# Multimodal Integration Plan

This document outlines the strategic plan to evolve the LLM Gateway into a fully multimodal service. The architecture has been refactored to use **capability-based provider types** rather than monolithic providers that handle everything.

## Architecture Philosophy

**Provider = Capability Endpoint** (not company)

Instead of "Gemini does everything", we have:
- **Chat Providers**: Handle text + vision (Gemini-Chat, Grok-Chat, Claude-Chat...)
- **Media Providers**: Handle image/video generation (Gemini-Imagen, OpenAI-DALL-E, Stability...)
- **Voice Providers**: Handle TTS/STT/realtime (Gemini-Audio, OpenAI-Whisper, ElevenLabs...)

This allows mixing best-of-breed providers and optimizing workflows per capability type.

---

## Phase 1: Base Vision Support (Chat Input) ✅ COMPLETE

*Target: Support inline images in OpenAI-compatible `image_url` format for vision-capable models.*

### 1.1 Adapter Capabilities Update
- **Impacted Files:** `src/adapters/*.js`, `src/config.js`
- **Action:** Introduce a `vision: true` boolean to provider capabilities.
- **Goal:** Allow the Router to strictly filter requests containing image payloads to models that actually support vision.

### 1.2 Token Estimation (`estimator.js`)
- **Impacted Files:** `src/context/estimator.js`
- **Action:** Update `estimateTokens()` to handle image content arrays.
- **Goal:** Accurate token counting for vision requests.

### 1.3 Context Mitigation & Compaction
- **Impacted Files:** `src/context/strategy.js`, `src/core/session.js`
- **Action:** Strip `image_url` objects from older context during compaction.
- **Goal:** Preserve text flow without blowing out token contexts.

### 1.4 Media Processing Architecture
- **Impacted Files:** `src/config.js`, MediaService (external)
- **Action:** External "Media Processor Node" for image downscaling.
- **Goal:** Offload heavy binary processing from Gateway core.

### Phase 1 Status
- [x] Vision capabilities working
- [x] Session compaction handles images
- [x] MediaService integration for image resizing

> **Note:** Media generation capabilities have been **removed** from base adapters. Image generation, TTS, and STT will be handled by separate provider types (see Phase 2).

---

## Phase 2: Capability-Based Provider Split 🔄 IN PROGRESS

*Target: Refactor media generation into separate provider types with dedicated workflows.*

### 2.1 Remove Media from Base Adapters
- **Impacted Files:** `src/adapters/base.js`, `src/adapters/gemini.js`, `src/adapters/openai.js`
- **Action:** Remove `generateImage()`, `synthesizeSpeech()`, and media capability flags.
- **Goal:** Base adapters handle **text + vision only**.

### 2.2 New Provider Types

#### Chat Providers (`type: chat`)
```javascript
{
  "gemini-chat": {
    "type": "chat",
    "vendor": "google",
    "apiKey": "${GEMINI_API_KEY}",
    "endpoint": "https://generativelanguage.googleapis.com/v1beta",
    "capabilities": ["chat", "vision", "streaming"]
  }
}
```
**Endpoints:**
- `POST /v1/chat/completions`
- `POST /v1/embeddings`

#### Media Providers (`type: media`)
```javascript
{
  "gemini-imagen": {
    "type": "media",
    "vendor": "google",
    "apiKey": "${GEMINI_API_KEY}",
    "endpoint": "https://generativelanguage.googleapis.com/v1beta",
    "capabilities": ["imageGeneration", "videoGeneration"]
  }
}
```
**Endpoints:**
- `POST /v1/images/generations` (async with tickets)
- `POST /v1/video/generations` (async with tickets)

#### Voice Providers (`type: voice`)
```javascript
{
  "gemini-audio": {
    "type": "voice",
    "vendor": "google",
    "apiKey": "${GEMINI_API_KEY}",
    "endpoint": "https://generativelanguage.googleapis.com/v1beta",
    "capabilities": ["tts", "stt"]
  }
}
```
**Endpoints:**
- `POST /v1/audio/speech` (synchronous binary)
- `POST /v1/audio/transcriptions` (synchronous)
- `WS /v1/audio/realtime` (WebSocket streaming)

### 2.3 Provider Adapter Interfaces

Each provider type implements its own interface:

```javascript
// Chat Provider Interface
interface ChatProvider {
  async predict(messages, model): Completion;
  async stream(messages, model): Stream<Chunk>;
  async embed(text, model): Embedding;
}

// Media Provider Interface
interface MediaProvider {
  async generateImage(prompt, model): Job;
  async generateVideo(prompt, model): Job;
  async getJobStatus(jobId): Status;
}

// Voice Provider Interface
interface VoiceProvider {
  async synthesize(text, voice, model): AudioBuffer;
  async transcribe(audioBuffer, model): Text;
  async streamRealtime(audioStream): DuplexStream;
}
```

### 2.4 Router Capability Dispatch

```javascript
// Router routes by capability, not provider name
async routeRequest(request) {
  if (request.path === '/v1/chat/completions') {
    return chatRouter.route(request);
  }
  if (request.path === '/v1/images/generations') {
    return mediaRouter.route(request);
  }
  if (request.path === '/v1/audio/speech') {
    return voiceRouter.route(request);
  }
}
```

### Phase 2 Definition of Done
- [ ] Media methods removed from base adapters
- [ ] New adapter types created: `chat`, `media`, `voice`
- [ ] Gemini-Media adapter (Imagen, Veo)
- [ ] Gemini-Voice adapter (TTS, STT)
- [ ] OpenAI-Media adapter (DALL-E)
- [ ] OpenAI-Voice adapter (Whisper, TTS)
- [ ] Router dispatches by endpoint type
- [ ] Separate model lists per provider type

---

## Phase 3: Media Workflows & Optimization

*Target: Implement proper async workflows for media generation.*

### 3.1 Async Ticket System for Media
- **Impacted Files:** `src/core/media-router.js`, `src/core/ticket-registry.js`
- **Action:** All media generation uses async tickets (`202 Accepted`).
- **Goal:** Handle long-running generation jobs without blocking connections.

### 3.2 Media Storage & Eviction
- **Impacted Files:** `src/utils/media-storage.js`
- **Action:** Temp file storage with TTL-based cleanup.
- **Goal:** Manage generated media files, auto-evict after expiration.

### 3.3 Provider-Specific Media Features
- **Gemini Media:** Imagen 4.0, Veo 3.0, Native Audio
- **OpenAI Media:** DALL-E 3, GPT-Image-1
- **Stability AI:** SDXL, SD3 (future)

### Phase 3 Definition of Done
- [ ] Async ticket workflow for all media generation
- [ ] Media file staging with TTL eviction
- [ ] Progress polling for long-running jobs
- [ ] Provider-specific parameter handling

---

## Phase 4: Voice & Realtime

*Target: Implement voice-specific workflows and realtime streaming.*

### 4.1 Synchronous Voice APIs
- **TTS:** `POST /v1/audio/speech` → binary audio response
- **STT:** `POST /v1/audio/transcriptions` → text response

### 4.2 Realtime Voice (WebSocket)
- **Endpoint:** `WS /v1/audio/realtime`
- **Providers:** OpenAI Realtime API, Gemini Live API
- **Features:** Duplex audio streaming, interruption handling

### Phase 4 Definition of Done
- [ ] TTS endpoint with binary streaming
- [ ] STT endpoint with file upload
- [ ] WebSocket realtime voice support
- [ ] Voice activity detection (VAD) integration

---

## Phase 5: Deep Multimodality (File Uploads)

*Target: Support large file uploads for video analysis.*

### 5.1 Files API
- **Endpoints:** `POST /v1/files`, `GET /v1/files`, `DELETE /v1/files`
- **Features:** Streaming upload, progress tracking, file lifecycle

### 5.2 Video Analysis
- **Provider:** Gemini (native video input)
- **Workflow:** Upload → Process → Reference in chat

### Phase 5 Definition of Done
- [ ] File upload API with streaming
- [ ] Video file processing
- [ ] File lifecycle management

---

## Configuration Examples

### Minimal Setup (Chat Only)
```json
{
  "providers": {
    "gemini-chat": {
      "type": "chat",
      "vendor": "google",
      "apiKey": "${GEMINI_API_KEY}",
      "model": "gemini-2.0-flash"
    }
  }
}
```

### Full Multimodal Setup
```json
{
  "providers": {
    "gemini-chat": {
      "type": "chat",
      "vendor": "google",
      "apiKey": "${GEMINI_API_KEY}",
      "model": "gemini-2.0-flash"
    },
    "gemini-media": {
      "type": "media",
      "vendor": "google",
      "apiKey": "${GEMINI_API_KEY}",
      "models": ["imagen-4.0", "veo-3.0"]
    },
    "gemini-voice": {
      "type": "voice",
      "vendor": "google",
      "apiKey": "${GEMINI_API_KEY}",
      "models": ["gemini-2.5-tts"]
    },
    "openai-media": {
      "type": "media",
      "vendor": "openai",
      "apiKey": "${OPENAI_API_KEY}",
      "models": ["dall-e-3"]
    },
    "elevenlabs-voice": {
      "type": "voice",
      "vendor": "elevenlabs",
      "apiKey": "${ELEVENLABS_KEY}",
      "models": ["eleven-multilingual-v2"]
    }
  }
}
```

---

## Migration Notes

### From Old to New Structure

**Before:**
```json
{
  "gemini": {
    "type": "gemini",
    "apiKey": "...",
    "capabilities": {
      "chat": true,
      "vision": true,
      "imageGeneration": true,
      "tts": true
    }
  }
}
```

**After:**
```json
{
  "gemini-chat": {
    "type": "chat",
    "vendor": "google",
    "apiKey": "..."
  },
  "gemini-media": {
    "type": "media",
    "vendor": "google",
    "apiKey": "..."
  },
  "gemini-voice": {
    "type": "voice",
    "vendor": "google",
    "apiKey": "..."
  }
}
```

### API Compatibility
- All endpoints remain OpenAI-compatible
- Clients use same HTTP paths
- Gateway handles routing internally

---

## Testing Strategy

Each provider type has comprehensive test suites:

```
docs/tests/probes/
├── gemini_comprehensive_test.mjs    # Tests chat + vision
├── gemini_media_test.mjs            # Tests Imagen, Veo
├── gemini_voice_test.mjs            # Tests TTS, STT
├── openai_media_test.mjs
├── openai_voice_test.mjs
└── ...
```

Run tests:
```bash
node docs/tests/probes/gemini_comprehensive_test.mjs
```

---

## Current Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1 | ✅ Complete | Vision working, MediaService integrated |
| Phase 2 | 🔄 In Progress | Removing media from base adapters |
| Phase 3 | ⏳ Pending | Async media workflows |
| Phase 4 | ⏳ Pending | Voice & realtime |
| Phase 5 | ⏳ Pending | File uploads & video |
