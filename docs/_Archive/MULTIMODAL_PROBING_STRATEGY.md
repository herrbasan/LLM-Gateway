# Provider Multimodal Probing Strategy

## Overview

Integrating multimodal capabilities (Text-to-Speech, Image Generation, Speech-to-Text) across various LLM providers (Google Gemini, Alibaba Qwen, Tencent GLM, xAI Grok, etc.) is difficult because the OpenAI payload standard (`/v1/audio/speech`, `/v1/images/generations`) often conflicts with the provider's native backend structures. 

Instead of guessing payload structures or testing blindly through the Gateway routing layers, this strategy relies on isolated **node.js sandbox probes**.

The goal is to discover the exact HTTP method, header requirements, model name, and payload shapes necessary to get a raw `Buffer` (audio/image) out of each provider so we can map that back to the Gateway adapters.

## The Strategy

### Phase 1: API Key & Capability Discovery

1. **Write a standard Node.js fetch script** (do not use `src/adapters`) that grabs the specific provider's API key from `.env`.
2. **Query the `GET /models` Native Endpoint** (if the provider supports it, e.g., `generativelanguage.googleapis.com/v1beta/models`).
   - Extract the full list of models.
   - Look for models with phrases like `tts`, `speech`, `audio`, `imagen`, `vision` to discover the exact internal string required (e.g., `gemini-2.0-flash-exp` instead of just `tts-1`).

### Phase 2: Isolated Component Testing (The Probe)

Create an isolated Node.js script for the specific capability that completely bypasses the Gateway's routing logic. 

**Example constraints for testing:**
- Do not import `http.js` or `router.js` from the gateway. Use native `fetch` or `node-fetch`.
- Manually construct the authorization headers as per the provider's official documentation.
- Try different combinations of payload bodies. 

*For Images:*
- Do they expect `size: "1024x1024"` or `width: 1024, height: 1024`?
- Do they return a JSON with a base64 string, or a direct binary stream?

*For Audio/TTS:*
- Does the provider expect `modalities: ["AUDIO"]` (like Gemini 2.0) or a separate endpoint (like `api.openai.com/v1/audio/speech`)?
- Does it return a direct chunked ArrayBuffer or a Base64-encoded string hidden in a JSON path like `candidates[0].content.parts[0].inlineData.data`?

### Phase 3: Validation

A successful probe must:
1. Return a `200 OK` status code.
2. Return an identifiable Content-Type (`audio/mpeg`, `audio/wav`, `image/png`, `image/jpeg`).
3. Have a valid byte-length. Calculate this doing `Buffer.from(await response.arrayBuffer()).byteLength` (or decoding the base64 output). A valid audio or image response will generally be `> 10000` bytes (10KB+). A size of 0, 56, or 100 bytes implies an error payload was returned rather than a media file.

### Phase 4: Integration (Handover to Copilot)

Once a sandbox script yields a correct payload, document the exact Native Payload shape. 

Share this shape with me (Copilot) with the instruction: 
> *“Here is the verified test for [Provider] [Capability]. Please refactor the corresponding adapter in `src/adapters/<provider>.js` to use this payload shape, and update `models.json` to route appropriately.”*

---

## Example Node.js Testing Template

Use this blueprint for writing isolated tests for the lesser model:

```javascript
// test_probe_template.js
const fs = require('fs');
require('dotenv').config(); // Ensure your .env is loaded

const API_KEY = process.env.YOUR_PROVIDER_API_KEY; 
const ENDPOINT = "https://api.provider.com/v1/desired/endpoint";

(async () => {
    console.log("🚀 Starting Probe...");

    try {
        const reqBody = {
            // EXPERIMENT WITH THIS SHAPE
            model: "their-exact-model-id",
            input: "Hello world this is a test.",
            // some networks need specific nested configs
            // parameters: { voice: "alloy" } 
        };

        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': \`Bearer \${API_KEY}\`
            },
            body: JSON.stringify(reqBody)
        });

        console.log("Status:", res.status);
        console.log("Content-Type:", res.headers.get("content-type"));

        // If it's a direct buffer (OpenAI style)
        if (res.headers.get("content-type").includes("audio") || res.headers.get("content-type").includes("application/octet-stream")) {
            const buffer = Buffer.from(await res.arrayBuffer());
            console.log("📦 Binary parsed. Byte length:", buffer.byteLength);
            
            if (buffer.byteLength > 1000) {
                 fs.writeFileSync('test_output.mp3', buffer);
                 console.log("✅ Success! Output saved to test_output.mp3");
            } else {
                 console.log("❌ Failed: Buffer too small, likely an issue.");
            }
        } 
        
        // If it's a JSON response (Gemini style)
        else if (res.headers.get("content-type").includes("json")) {
            const data = await res.json();
            console.log("📄 JSON response received:");
            if (data.error) {
                 console.error("❌ API Error:", JSON.stringify(data.error, null, 2));
                 return;
            }
            
            console.log(JSON.stringify(data).substring(0, 300) + '...');
            
            // Check for base64
            // const b64 = data.candidates?.[0]...
            // const buffer = Buffer.from(b64, 'base64');
            // fs.writeFileSync('test_output.wav', buffer);
        } else {
            console.log("❓ Unknown content type format");
            console.log(await res.text());
        }

    } catch (err) {
        console.error("💥 Probe crashed:", err.message);
    }
})();
```

## Checklist by Provider

For your agent, track these:
- [ ] **Gemini**: Image Generation payload (Imagen vs standard).
- [ ] **Gemini**: Audio/Speech payload (Are voices customizable? Is there a standalone model?).
- [ ] **Qwen / Dashscope**: TTS endpoint compatibility (e.g. `sambert-zhichu-v1`).
- [ ] **GLM / Zhipu**: TTS endpoint logic and supported voices.
- [ ] **Minimax**: Text-to-speech mapping requirements.
- [ ] **Grok**: Image generation endpoint and structural mappings.
