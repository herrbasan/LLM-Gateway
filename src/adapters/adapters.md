# Adapters Documentation

This document outlines the internal behaviors, supported endpoint features, and API specific nuances of the natively supported LLM Gateway adapters. Our adapters normalize disparate provider APIs back into standard, seamless OpenAI SDK interfaces.

---

## 1. Gemini Adapter
**Source:** `src/adapters/gemini.js`  
**Official Docs:** [https://ai.google.dev/gemini-api/docs](https://ai.google.dev/gemini-api/docs)

The Gemini adapter is built to consume the most current native Google REST endpoints, converting them seamlessly into strictly compliant OpenAI structures.

### Key Mapped Features
- **API Version Target**: `v1beta`. Using `v1beta` allows the Gateway to support the absolute latest model aliases (like `gemini-3.1-pro-preview` and `gemini-2.5-flash`) efficiently.
- **Role Transformation (`System` Mapping):** Automatically extracts standard OpenAI `{ role: "system" }` objects and pipes them correctly into Gemini's expected root `system_instruction` format.
- **Native Prompt Stream Completion:** Both standard synchronous answers and high-throughput Server-Sent Events (SSE) stream back matching OpenAI `.chunk` objects natively.
- **Accurate Token Counting:** Uses the native model-specific `countTokens` endpoint via REST rather than simple character-guess algorithms for flawless context-window mapping.
- **Batch Embeddings (`batchEmbedContents`):** Standard string Arrays sent to `/embeddings` natively wrap into Google's batch rest payloads, avoiding iteration N+1 throttling.

### Structured Output Capabilities
Gemini heavily enforces deterministic structure parsing using deep JSON parameters.
- **Enabled Config Toggle:** `capabilities.structuredOutput: true`
- If an OpenAI `response_format: { type: "json_schema" }` is passed down, the adapter triggers Google's `responseMimeType: "application/json"` and maps the exact JSON schema over to `responseJsonSchema` residing in the `generationConfig` block.
- **Note:** Standard JSON schema datatypes must be rigorously respected here (e.g. `type: "object"`, `type: "string"`). Gemini natively blocks overly complex/deeply-nested schemas as a safety layer on their side, but standard enum schemas are passed correctly. 

### Current Constraints
- Uses the `v1beta` endpoint to track the most state-of-the-art beta schemas. Be advised, beta environments occasionally undergo payload shift depending on Google announcements. 
- Usage analytics from Gemini currently do not provide boundary outputs back on Batch Embeddings out of the box in `v1beta` at lengths comparable to OpenAI metrics. As such, zeroed stub usages are presently returned on `embedText`. 

---

## 2. LM Studio Adapter
**Source:** `src/adapters/lmstudio.js`
**Official Docs:** [https://lmstudio.ai/docs/developer/rest](https://lmstudio.ai/docs/developer/rest)

Acts as a first-class local gateway interface supporting raw Open-Weight models running natively. LM Studio offers differing API paths natively (v1 vs `/api/v1`). Our adapter maps directly against the standard standard OpenAI-compatible endpoints that LMStudio exposes out-of-the-box.

### Key Mapped Features
- **Base Endpoint Mapping:** Expects models exposed roughly on `http://localhost:1234/v1`.
- **Drop-In Compatibility:** Fully compatible with `/chat/completions` and payload semantics (`temperature`, `top_p`, `max_tokens` etc.).
- **Dynamic Model Loading & Resolution:** The `listModels` method reaches back through LMStudio's `/models` endpoint to see all *Just-In-Time* cached files.
- **Function Calling & MCP:** Full structured tool support via standard OpenAI format mappings.

*Note on constraints*: Because it relies heavily on standard standard OpenAI `chat/completions` for tool support, it explicitly bypasses native v1 `/api/v1/chat` features (like Prompt Processing events) in favor of deep SDK stability.

---

## 3. Ollama Adapter
**Source:** `src/adapters/ollama.js`
**Official Docs:** [https://docs.ollama.com/](https://docs.ollama.com/)

Acts identically for local Ollama hosting systems running globally, acting primarily via HTTP `curl`-based integrations.

### Key Mapped Features
- **Base Endpoint Mapping:** Expects environments mapping locally to `http://localhost:11434`.
- **Model Discovery Mapping (Deviation):** Distinct from standard OpenAI integrations, the `listModels` adapter leverages Ollama's native `/api/tags` to map their internal schema back onto standard `v1/models` formats.
- **Streaming & Reasoning models:** Natively handles chunked responses containing advanced reasoning models like Deepseek natively embedded in chunks.
- **Tools & JSON Formatting:** Fully supports `response_format` schemas mapping to Ollama's standard JSON constraints engine.

---

## 4. OpenAI Adapter (and Cloud Wrappers)
**Source:** `src/adapters/openai.js`

Acts as a fallback pass-through for natively routing directly to OpenAI services or to natively compatible generic cloud wrapper APIs (such as xAI Grok, Kimi, GLM, Minimax, Qwen). Because many cloud providers strictly adopt the exact OpenAI payload shape, simply configuring an API endpoint with `type: "openai"` connects them natively to the Gateway.

### A. xAI Grok Specifics
**Official Docs:** [https://docs.x.ai/developers/introduction](https://docs.x.ai/developers/introduction)
When targeting `https://api.x.ai/v1/chat/completions`:
- **Streaming Quirks:** Specifically for *function calling tools*, it returns the payload in a single bulk chunk rather than token-by-token.
- **Strict Parameter Rejections for Grok 4:** Requests leveraging `grok-4` reasoning will throw a hard API error if you include `presence_penalty`, `frequency_penalty`, or `stop` parameters.
- **Timeouts:** Recommended to be lifted dynamically as `grok-4` can take deeply extended background reasoning intervals before streaming completion.

### B. MiniMax Specifics
**Official Docs:** [https://platform.minimax.io/docs/guides/models-intro](https://platform.minimax.io/docs/guides/models-intro)

MiniMax uses the **Anthropic Messages API** format, not OpenAI. The adapter targets `https://api.minimax.io/anthropic`.

**Configuration:**
```json
{
  "type": "minimax",
  "apiKey": "${MINIMAX_API_KEY}",
  "model": "MiniMax-M2.5"
}
```

### Key Mapped Features
- **API Format:** Anthropic Messages API (`v1/messages` endpoint)
- **Context Windows:** Massive 200k+ token inputs
- **Reasoning Models:** Returns `thinking` blocks alongside text responses
- **Response Format:** `content[]` array with `type: "text"` blocks
- **Models:** `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`, `MiniMax-Text-01`
- **Highspeed Variants:** Use `-highspeed` suffix for rapid code generation streams

### C. Zhipu GLM Specifics
**Official Docs:** [https://docs.z.ai/guides/overview/quick-start](https://docs.z.ai/guides/overview/quick-start)
When targeting `https://api.z.ai/api/paas/v4/chat/completions`:
- **Parameter Conflict Warnings:** Setting both `temperature` and `top_p` sampling arrays causes instability. Pass exclusively one down the router if routing to GLM.
- **Thinking Chains:** Native deep reasoning flag architectures are triggered globally in GLM 4.5+ through custom payload markers that function identically.
- **Token Constraints:** Capable of immense single-call output lengths up to 131,072.

### D. Moonshot Kimi / Kimi Code Specifics

There are **two separate services** for accessing Kimi models:

#### 1. Kimi Code (Coding Subscription)
**Website:** [kimi.com/code](https://kimi.com/code)  
**Endpoint:** `https://api.kimi.com/coding/v1`

Coding-agent focused subscription with OpenAI-compatible HTTP API. Uses a dedicated `kimi` adapter that handles Kimi-specific requirements.

**Configuration:**
```json
{
  "type": "chat",
  "adapter": "kimi",
  "endpoint": "https://api.kimi.com/coding/v1",
  "apiKey": "${KIMI_API_KEY}",
  "adapterModel": "kimi-k2.5",
  "capabilities": {
    "contextWindow": 256000,
    "structuredOutput": true,
    "streaming": true
  }
}
```

- **Full conversation history** via native `messages` array
- Native streaming and structured output support
- **Vision support** - Base64-encoded images only (URLs must be fetched/converted by client)
- **Automatic handling** of Kimi-specific requirements:
  - Sets required `User-Agent: Kilo-Code/1.0` header
  - Wraps `reasoning_content` in `<think>` tags for consistent handling with other reasoning models
  - Works with gateway's thinking stripper to filter out reasoning when configured

**Model Support:** `kimi-k2.5`, `kimi-k2-thinking-turbo`

#### 2. Moonshot Open Platform (General API)
**Website:** [platform.moonshot.cn](https://platform.moonshot.cn/)  
**Docs:** [https://platform.moonshot.cn/docs](https://platform.moonshot.cn/docs)

General-purpose API access to Kimi models. Separate from Kimi Code - different account, different API keys.

**Configuration:**
```json
{
  "type": "chat",
  "adapter": "openai",
  "endpoint": "https://api.moonshot.cn/v1",
  "apiKey": "${MOONSHOT_API_KEY}",
  "adapterModel": "kimi-k2.5",
  "capabilities": {
    "contextWindow": 256000,
    "structuredOutput": true,
    "streaming": true
  }
}
```

#### 3. Kimi CLI (Legacy)
**Note:** The `kimi-cli` adapter exists for legacy CLI-based access but is **not recommended** for new setups. The HTTP API provides better conversation history handling and native streaming.

**Important Limitations:**
- **Fixed output token limit:** The CLI tool has an internal maximum output limit (typically ~4096 tokens) that cannot be configured via command line arguments. The gateway's `max_tokens` parameter is ignored.
- **Use `maxOutputTokens` capability:** Configure this in your model config to match the CLI's actual limit. The adapter will warn if requests exceed this.
- **Output shrinkage:** Long conversations may appear to produce shorter outputs as the CLI hits its fixed limit while the gateway calculates dynamic budgets.

**Configuration:**
```json
{
  "type": "chat",
  "adapter": "kimi-cli",
  "adapterModel": "kimi-k2.5",
  "capabilities": {
    "contextWindow": 256000,
    "maxOutputTokens": 4096,
    "vision": false
  }
}
```

### E. Alibaba Cloud Qwen (DashScope) Specifics
**Official Docs:** [https://www.alibabacloud.com/help/en/model-studio/getting-started/what-is-model-studio](https://www.alibabacloud.com/help/en/model-studio/getting-started/what-is-model-studio)

Qwen models are accessed via the **DashScope** platform using OpenAI-compatible endpoints.

**Endpoint:** `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

For China-based deployments, use: `https://dashscope.aliyuncs.com/compatible-mode/v1`

### Key Mapped Features
- **Full OpenAI Compatibility:** The `/v1/chat/completions` endpoint accepts standard OpenAI request formats including `messages`, `temperature`, `max_tokens`, `stream`, and `response_format`.
- **Streaming Support:** Server-Sent Events (SSE) are fully supported for real-time token streaming.
- **Structured Output:** JSON mode works via `response_format: { type: "json_object" }` for compatible models.
- **Multimodal Capabilities:** Qwen-VL models support image inputs via base64-encoded URLs in the message content.

### Available Model Families
- **qwen-turbo**: Fast, cost-effective for general tasks
- **qwen-plus**: Balanced performance and capability
- **qwen-max**: Maximum capability for complex reasoning
- **qwen-coder**: Specialized for code generation
- **qwen-vl**: Vision-language models for image understanding

### Authentication
Obtain API keys from the [Alibaba Cloud Model Studio Console](https://modelstudio.console.alibabacloud.com/). The key format is typically `sk-...`.

---

## 5. Summary: Provider Quick Reference

| Provider | Adapter Type | Endpoint | Embeddings | Streaming | JSON Mode |
|----------|--------------|----------|------------|-----------|-----------|
| Gemini | `gemini` | `generativelanguage.googleapis.com/v1beta` | ✅ | ✅ | ✅ |
| LM Studio | `lmstudio` | `localhost:1234/v1` | ✅ | ✅ | ✅ |
| Ollama | `ollama` | `localhost:11434` | ✅ | ✅ | ❌ |
| Grok | `openai` | `api.x.ai/v1` | ❌ | ✅ | ✅ |
| MiniMax | `minimax` | `api.minimax.io/anthropic` | ❌ | ❌ | ✅ |
| GLM | `openai` | `api.z.ai/api/paas/v4` | ❌ | ✅ | ✅ |
| Kimi Code | `kimi` | `api.kimi.com/coding/v1` | ❌ | ✅ | ✅* |
| Kimi Platform | `openai` | `api.moonshot.cn/v1` | ❌ | ✅ | ✅ |
| Qwen | `openai` | `dashscope-intl.aliyuncs.com/compatible-mode/v1` | ❌ | ✅ | ✅ |

\* *Kimi Code vision requires base64-encoded images; image URLs are not supported directly*
