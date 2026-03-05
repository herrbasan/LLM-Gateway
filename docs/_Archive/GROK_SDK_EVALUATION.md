# xAI SDK Integration Evaluation

**Date:** 2026-03-04  
**Context:** Evaluating whether to use the official xAI SDK (`@ai-sdk/xai`) for the Grok adapter

---

## Current Implementation

The Grok adapter currently uses the **generic `openai.js` adapter** with:
- Raw HTTP requests via `src/utils/http.js`
- OpenAI-compatible endpoint (`https://api.x.ai/v1`)
- Standard fetch-based streaming
- ~30 lines of code for image generation handling

---

## xAI SDK Options

### Option 1: Vercel AI SDK (`@ai-sdk/xai`)
```bash
npm install ai @ai-sdk/xai
```

**Usage:**
```javascript
import { createXai } from '@ai-sdk/xai';
import { generateText, streamText } from 'ai';

const xai = createXai({ apiKey: process.env.XAI_API_KEY });

// Text generation
const { text } = await generateText({
    model: xai.responses('grok-4'),
    prompt: 'Hello world',
});

// Streaming
const { textStream } = await streamText({
    model: xai.responses('grok-4'),
    prompt: 'Hello world',
});

// Vision
const { text } = await generateText({
    model: xai.responses('grok-4'),
    messages: [{
        role: 'user',
        content: [
            { type: 'image', image: 'https://...' },
            { type: 'text', text: "What's in this image?" },
        ],
    }],
});
```

### Option 2: xAI Native SDK
```bash
npm install @xai/sdk
```

**Usage:**
```javascript
import { createXai } from '@xai/sdk';

const xai = createXai({ apiKey: process.env.XAI_API_KEY });

const response = await xai.chat.completions.create({
    model: 'grok-4',
    messages: [{ role: 'user', content: 'Hello' }],
});
```

---

## Pros and Cons Analysis

### ✅ Benefits of Using xAI SDK

| Benefit | Impact | Notes |
|---------|--------|-------|
| **Type Safety** | Medium | Full TypeScript support for requests/responses |
| **Streaming** | Medium | Built-in streaming with better error handling |
| **Future-proof** | High | Automatic support for new Grok features |
| **Better Errors** | Medium | More descriptive error messages |
| **Vision Support** | High | Native handling of image inputs |
| **Tool Calling** | Medium | Built-in function calling helpers |

### ❌ Drawbacks of Using xAI SDK

| Drawback | Impact | Notes |
|----------|--------|-------|
| **Dependency** | Medium | Adds ~50-100KB to bundle size |
| **Architecture Mismatch** | High | Different pattern from other adapters |
| **Custom Adapter Needed** | High | Can't reuse `openai.js` anymore |
| **Maintenance** | Medium | Separate code path to maintain |
| **Flexibility** | Low | Locked into SDK's implementation |
| **Circuit Breaker** | Medium | Would need to integrate with existing http.js circuit breaker |

---

## Architecture Comparison

### Current (OpenAI-compatible adapter)
```
Gateway Request → openai.js → http.js → api.x.ai/v1
                     ↑
            (shared with other providers)
```

### With xAI SDK
```
Gateway Request → grok-sdk.js → @ai-sdk/xai → api.x.ai/v1
                     ↑
            (separate from other adapters)
```

---

## Recommendation

### **Short-term: Keep current approach** ✅

The current OpenAI-compatible adapter is working well:
- Image generation: ✅ Working
- Chat: ✅ Working  
- Streaming: ✅ Working
- Vision: ⚠️ API key tier issue (not SDK issue)

**Reasons:**
1. **Consistency:** All cloud providers (Grok, Qwen, GLM) use the same `openai.js` adapter
2. **Maintenance:** Single codebase for OpenAI-compatible providers
3. **Flexibility:** Direct HTTP control for custom headers, retries, etc.
4. **Working:** No functional gaps currently

### **Long-term: Consider SDK if...**

1. **Native features needed:** If xAI introduces SDK-only features (e.g., advanced tool calling)
2. **Vision becomes critical:** If we need vision and SDK handles it better
3. **Type safety priority:** If migrating entire codebase to stricter TypeScript

### **Hybrid approach (recommended if needed):**

Create a separate `grok-native.js` adapter that uses the SDK for advanced features while keeping `openai.js` for basic compatibility:

```javascript
// config.json
{
  "grok": {
    "type": "grok-native",  // New adapter
    // ...
  },
  "grok-compat": {
    "type": "openai",  // Existing
    // ...
  }
}
```

---

## Conclusion

**No immediate action needed.** The current implementation is solid. 

Consider SDK migration only if:
- xAI deprecates OpenAI-compatible endpoints
- We need SDK-exclusive features
- Type safety becomes a critical requirement

---

## Appendix: Current vs SDK Feature Matrix

| Feature | Current (openai.js) | xAI SDK | Gap |
|---------|---------------------|---------|-----|
| Chat | ✅ | ✅ | None |
| Streaming | ✅ | ✅ | None |
| Image Gen | ✅ | ✅ | None |
| Vision | ⚠️ (API tier) | ⚠️ (API tier) | Same limitation |
| Tool Calling | ✅ | ✅ | None |
| Structured Output | ✅ | ✅ | None |
| Files API | ❌ | ❌ | Not implemented |
| Embeddings | ❌ | ❌ | Not available |
