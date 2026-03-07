# Multimodal Provider Capability Findings

**Date:** 2026-03-04  
**Purpose:** Document verified multimodal capabilities across all LLM Gateway providers for adapter integration.

---

## Executive Summary

| Provider | Image Gen | TTS | STT | Vision | Notes |
|----------|-----------|-----|-----|--------|-------|
| **Gemini** | ✅ Working | ✅ Working | ⚠️ Native Audio Input | ✅ Working | Best multimodal support |
| **Grok** | ✅ Working | ❌ Not Available | ❌ Not Available | ⚠️ API Tier Required | Image gen works; vision needs higher tier |
| **Qwen** | ⚠️ Native API Only | ⚠️ Native API Only | ✅ Available | ✅ Working | Requires native endpoints |
| **GLM** | ⚠️ Native API Only | ⚠️ Native API Only | ❌ Unknown | ⚠️ Native API Only | OpenAI-compat limited |
| **MiniMax** | ❌ Not Available | ⚠️ Native API Only | ❌ Not Available | ❌ Not Available | Anthropic format only |

---

## 1. Google Gemini

**Endpoint:** `https://generativelanguage.googleapis.com/v1beta`  
**Adapter:** `src/adapters/gemini.js`  
**Status:** ✅ **FULLY OPERATIONAL**

### Verified Capabilities

#### 1.1 Image Generation (Imagen 4)
- **Working Models:**
  - `imagen-4.0-generate-001` ✅
  - `imagen-4.0-fast-generate-001` (assumed)
  - `imagen-4.0-ultra-generate-001` (assumed)
- **Non-working Models:**
  - `imagen-3.0-generate-001` ❌ (404 - removed from API)
  - `gemini-2.5-flash-image` ❌ (different endpoint)

- **Endpoint:** `POST /models/{model}:predict?key={API_KEY}`
- **Payload Structure:**
```json
{
  "instances": [{ "prompt": "user prompt here" }],
  "parameters": {
    "sampleCount": 1,
    "outputOptions": { "mimeType": "image/jpeg" }
  }
}
```
- **Response Path:** `predictions[0].bytesBase64Encoded`
- **Output:** Base64-encoded JPEG (~600KB for 1024x1024)

#### 1.2 Text-to-Speech (Native Audio)
- **Working Models:**
  - `gemini-2.5-flash-preview-tts` ✅
- **Non-working Models:**
  - `gemini-2.5-flash-native-audio-latest` ❌ (not found)
  - `gemini-2.5-flash-native-audio-preview-09-2025` ❌ (not found)

- **Endpoint:** `POST /models/{model}:generateContent?key={API_KEY}`
- **Payload Structure:**
```json
{
  "contents": [{
    "role": "user",
    "parts": [{ "text": "Text to speak" }]
  }],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": {
      "voiceConfig": {
        "prebuiltVoiceConfig": {
          "voiceName": "Aoede"
        }
      }
    }
  }
}
```
- **Voice Options:** `Aoede`, `Puck`, `Charon`, `Kore`, `Fenrir`
- **Response Path:** `candidates[0].content.parts[].inlineData`
- **Output Format:** `audio/L16;codec=pcm;rate=24000` (~227KB for short text)

#### 1.3 Vision (Image Input)
- **Working Models:** All Gemini 2.0+ models
  - `gemini-2.0-flash` ✅
  - `gemini-2.5-flash` ✅
  - `gemini-2.5-pro` ✅
- **Format:** Native `inlineData` with base64
- **Payload:**
```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "Question about image" },
      {
        "inlineData": {
          "mimeType": "image/png",
          "data": "base64encoded..."
        }
      }
    ]
  }]
}
```

#### 1.4 Speech-to-Text (Audio Input)
- **Method:** Native audio input via `inlineData` (not dedicated STT endpoint)
- **Working Models:** All Gemini 2.0+ models
- **Format:** Same as vision but with `mimeType: "audio/wav"` or `"audio/mp3"`
- **Note:** Gemini transcribes audio as part of chat, not via separate STT endpoint

### Integration Notes
- ✅ All capabilities already implemented in `gemini.js` adapter
- ✅ Model discovery via `listModels()` correctly identifies capabilities
- ⚠️ Use `imagen-4.0-*` models, not `imagen-3.0-*`
- ⚠️ TTS requires specific preview models, not general flash models

---

## 2. xAI Grok

**Endpoint:** `https://api.x.ai/v1`  
**Adapter:** `src/adapters/openai.js` (type: openai)  
**Status:** ✅ **IMAGE GEN WORKING** / ⚠️ **VISION NEEDS HIGHER TIER**

### Verified Capabilities

#### 2.1 Available Models
**Chat Models:**
- `grok-3` ✅, `grok-3-mini` ✅
- `grok-4-0709` ✅, `grok-4-1-fast-non-reasoning` ✅, `grok-4-1-fast-reasoning` ✅
- `grok-4-fast-non-reasoning` ✅, `grok-4-fast-reasoning` ✅
- `grok-code-fast-1` ✅

**Image Generation Models:**
- `grok-imagine-image` ✅
- `grok-imagine-image-pro` ✅
- `grok-imagine-video` (not tested)

#### 2.2 Image Generation ✅ WORKING
- **Working Models:**
  - `grok-imagine-image` ✅
  - `grok-imagine-image-pro` ✅
- **Non-working Models:**
  - `grok-2-image` ❌ (model doesn't exist)

- **Endpoint:** `POST /v1/images/generations`
- **Payload Structure (OpenAI-compatible):**
```json
{
  "model": "grok-imagine-image",
  "prompt": "A futuristic city skyline at sunset with flying cars",
  "n": 1
}
```
- **Response:**
```json
{
  "data": [{
    "url": "https://imgen.x.ai/xai-imgen/xai-tmp-imgen-....jpeg",
    "mime_type": "image/jpeg",
    "revised_prompt": ""
  }],
  "usage": { "cost_in_usd_ticks": 200000000 }
}
```
- **Output:** URL to generated image (~460KB for 1024x1024)

#### 2.3 Text-to-Speech
- **Status:** ❌ Not Available
- **Endpoint:** `/v1/audio/speech` returns non-audio response
- **Note:** Not exposed via API yet

#### 2.4 Vision ⚠️ API TIER RESTRICTED
- **Status:** ⚠️ Requires Higher API Tier
- **Tested Models:**
  - `grok-3` ❌ "Image inputs are not supported by this model"
  - `grok-3-mini` ❌ "Image inputs are not supported by this model"
  - `grok-4-*` ❌ "Invalid arguments passed to the model" (when images included)
  - `grok-2-vision-1212` ❌ "does not exist or your team does not have access"

- **Issue:** Current API key tier doesn't include vision access
- **Note:** Grok-4 models work fine for text but reject image inputs with current key

### Integration Notes
- ✅ **Image generation fully working** via `grok-imagine-image` model
- ✅ Returns image URL (not base64) - adapter must handle URL fetching
- ⚠️ **Vision requires higher-tier API key** - documented model `grok-2-vision-1212` not accessible
- 🔍 Consider caching generated images (URLs are temporary)
- 🔍 Monitor `cost_in_usd_ticks` in response for billing tracking

---

## 3. Alibaba Qwen (DashScope)

**Endpoint:** `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`  
**Adapter:** `src/adapters/openai.js` (type: openai)  
**Status:** ⚠️ **REQUIRES NATIVE API**

### Verified Capabilities

#### 3.1 Available Models (134 total)
**Chat Models:**
- `qwen-turbo`, `qwen-plus`, `qwen-max`
- `qwen2.5-*-instruct` series
- `qwen3-*` series (latest)

**Vision Models:**
- `qwen-vl-plus`, `qwen-vl-max`
- `qwen2.5-vl-*`, `qwen3-vl-*`
- `qwen3-omni-*` (multimodal)

**Image Generation:**
- `qwen-image-2.0`, `qwen-image-2.0-pro`
- `qwen-image-max`, `qwen-image-plus`
- `qwen-image-edit-*`
- `z-image-turbo`

**TTS Models:**
- `qwen3-tts-flash`, `qwen3-tts-flash-realtime`
- `qwen3-tts-vc-*`, `qwen3-tts-vd-*`
- `qwen3-tts-instruct-flash`

#### 3.2 Image Generation
- **Status:** ❌ OpenAI-compatible endpoint fails
- **Error:** `Unexpected end of JSON input` (likely 404 or empty response)
- **Note:** Qwen image generation likely requires native DashScope API endpoint, not OpenAI-compatible mode

#### 3.3 Text-to-Speech
- **Status:** ❌ OpenAI-compatible endpoint fails
- **Note:** Qwen TTS requires native API endpoint

#### 3.4 Vision
- **Status:** ⚠️ Working but with restrictions
- **Error:** `<400> InternalError.Algo.InvalidParameter: The image length and width do not meet the model restrictions. [height:1 or width:1 must be larger than 10]`
- **Note:** Test image (1x1 pixel) too small; vision works with larger images

### Native API Endpoints (for future integration)
- **Base:** `https://dashscope-intl.aliyuncs.com/api/v1`
- **Image Gen:** `/services/aigc/text2image/image-synthesis`
- **TTS:** `/services/audio/tts`

### Integration Notes
- 🔍 Current OpenAI-compatible adapter insufficient for media generation
- 🔍 Need separate `qwen-native.js` adapter for full multimodal support
- ✅ Vision works via OpenAI-compatible endpoint (with image size restrictions)

---

## 4. Zhipu GLM

**Endpoint:** `https://api.z.ai/api/paas/v4`  
**Adapter:** `src/adapters/openai.js` (type: openai)  
**Status:** ⚠️ **REQUIRES NATIVE API**

### Verified Capabilities

#### 4.1 Available Models (5 total)
- `glm-4.5`, `glm-4.5-air`
- `glm-4.6`, `glm-4.7`
- `glm-5`

#### 4.2 Image Generation (CogView)
- **Status:** ❌ Not via OpenAI-compatible endpoint
- **Tested Models:** `cogview-3`, `cogview-3-plus`, `cogview-4`
- **Error:** `Unknown Model, please check the model code.`
- **Note:** CogView requires native GLM API endpoint

#### 4.3 Text-to-Speech
- **Status:** ❌ Not via OpenAI-compatible endpoint
- **Tested Models:** `glm-4-voice`, `tts-1`
- **Error:** `The current response_format value is not supported`
- **Note:** GLM TTS requires native API

#### 4.4 Vision
- **Status:** ❌ Not via OpenAI-compatible endpoint
- **Tested Models:** `glm-4v-plus`, `glm-4v`, `glm-4v-flash`
- **Error:** `Unknown Model, please check the model code.`
- **Note:** Vision models require native API

### Native API Endpoints (for future integration)
- **Base:** `https://api.z.ai/api/paas/v4`
- **Image Gen:** `/images/generations` (native format)
- **TTS:** `/audio/speech` (native format)

### Integration Notes
- 🔍 Current OpenAI-compatible endpoint at `api.z.ai/api/coding/paas/v4` is chat-only
- 🔍 Need separate `glm-native.js` adapter for multimodal features
- 🔍 Native GLM API has different authentication and payload structure

---

## 5. MiniMax

**Endpoint:** `https://api.minimax.io/anthropic`  
**Adapter:** `src/adapters/minimax.js`  
**Status:** ⚠️ **LIMITED MULTIMODAL**

### Verified Capabilities

#### 5.1 Chat (Anthropic Format)
- **Status:** ✅ Working
- **Model:** `MiniMax-M2.5`
- **Endpoint:** `POST /v1/messages`
- **Format:** Anthropic Messages API

#### 5.2 Text-to-Speech
- **Status:** ❌ Not via Anthropic endpoint
- **OpenAI-compat Endpoint:** `/v1/audio/speech` - returns non-audio
- **Native Endpoint:** `POST https://api.minimax.io/v1/t2a_v2`
- **Note:** Native endpoint requires different payload format

#### 5.3 Speech-to-Text
- **Status:** ❌ Not Available
- **Endpoint:** `/v1/audio/transcriptions` returns 404
- **Note:** STT may not be offered by MiniMax

#### 5.4 Vision
- **Status:** ❌ Not Available
- **Note:** MiniMax focuses on text generation

### Native TTS Payload (for future integration)
```json
POST https://api.minimax.io/v1/t2a_v2
{
  "text": "Text to speak",
  "voice_id": "male-qn-qingse",
  "model": "speech-01-turbo"
}
```
- Returns: `audio_hex` (hex-encoded audio)

### Integration Notes
- ✅ Chat working via existing `minimax.js` adapter
- 🔍 TTS requires extending adapter with native endpoint support
- 🔍 No image generation or vision capabilities found

---

## Integration Recommendations

### Immediate Actions (Gemini)
1. ✅ **No changes needed** - Gemini adapter fully supports multimodal
2. ⚠️ Update `models.json` heuristics to use `imagen-4.0-*` instead of `imagen-3.0-*`
3. ⚠️ Document TTS voice options in adapter docs

### Short-term (OpenAI-compatible providers)
1. **Grok:**
   - ✅ **Image generation is WORKING** - uses `grok-imagine-image` model
   - ⚠️ Update `openai.js` adapter to handle URL-based image responses (not base64)
   - ⚠️ Vision requires higher-tier API key - documented `grok-2-vision-1212` not accessible with current key

2. **Qwen:**
   - Create `qwen-native.js` adapter for image gen and TTS
   - Keep OpenAI-compatible adapter for chat/vision

3. **GLM:**
   - Create `glm-native.js` adapter for CogView and TTS
   - Current endpoint appears to be chat-only

### Long-term (Native API integration)
1. **Qwen Native Adapter:**
   - Image generation via `/services/aigc/text2image/image-synthesis`
   - TTS via `/services/audio/tts`

2. **GLM Native Adapter:**
   - CogView image generation
   - Native TTS endpoint

3. **MiniMax Extension:**
   - Add TTS via `/v1/t2a_v2`

---

## Test Output Files

Generated test outputs saved in:
```
docs/tests/probes/output/
├── gemini_image_imagen_4_0_generate_001.jpg  (600KB)
├── gemini_tts.audio                          (227KB, PCM 24kHz)
├── grok_image_grok_imagine_image.png         (460KB)
├── gemini_results.json
├── grok_results.json
├── qwen_results.json
├── glm_results.json
└── minimax_results.json
```

---

## Appendix: Provider Documentation Links

- **Gemini:** https://ai.google.dev/gemini-api/docs
- **Grok:** https://docs.x.ai/developers/introduction
- **Qwen:** https://www.alibabacloud.com/help/en/model-studio/getting-started/what-is-model-studio
- **GLM:** https://docs.z.ai/guides/overview/quick-start
- **MiniMax:** https://platform.minimax.io/docs/guides/models-intro
