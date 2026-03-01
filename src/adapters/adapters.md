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

Acts as a fallback pass-through for natively routing directly to OpenAI services or to natively compatible generic cloud wrapper APIs (such as xAI Grok, Kimi, GLM, Minimax). Because many cloud providers strictly adopt the exact OpenAI payload shape, simply configuring an API endpoint with `type: "openai"` connects them natively to the Gateway.

### A. xAI Grok Specifics
**Official Docs:** [https://docs.x.ai/developers/introduction](https://docs.x.ai/developers/introduction)
When targeting `https://api.x.ai/v1/chat/completions`:
- **Streaming Quirks:** Specifically for *function calling tools*, it returns the payload in a single bulk chunk rather than token-by-token.
- **Strict Parameter Rejections for Grok 4:** Requests leveraging `grok-4` reasoning will throw a hard API error if you include `presence_penalty`, `frequency_penalty`, or `stop` parameters.
- **Timeouts:** Recommended to be lifted dynamically as `grok-4` can take deeply extended background reasoning intervals before streaming completion.

### B. MiniMax Specifics
**Official Docs:** [https://platform.minimax.io/docs/guides/models-intro](https://platform.minimax.io/docs/guides/models-intro)
When targeting `https://api.minimax.io/v1`:
- **Context Windows:** Supports massive 200k+ inputs. Ensure the Gateway `maxTokens` limits do not clip configurations needlessly.
- **Optimizations:** Utilize models tagged with `-highspeed` variants for rapid code generation streams alongside standard agentic workflows.
- **Output Thresholds:** Extremely generous, supporting 128,000 tokens printed out (specifically useful for complex Chain of Thought processes).

### C. Zhipu GLM Specifics
**Official Docs:** [https://docs.z.ai/guides/overview/quick-start](https://docs.z.ai/guides/overview/quick-start)
When targeting `https://api.z.ai/api/paas/v4/chat/completions`:
- **Parameter Conflict Warnings:** Setting both `temperature` and `top_p` sampling arrays causes instability. Pass exclusively one down the router if routing to GLM.
- **Thinking Chains:** Native deep reasoning flag architectures are triggered globally in GLM 4.5+ through custom payload markers that function identically.
- **Token Constraints:** Capable of immense single-call output lengths up to 131,072.

### D. Moonshot Kimi Specifics
**Official Docs:** [https://www.kimi.com/code/docs/en/](https://www.kimi.com/code/docs/en/)
When targeting `https://api.kimi.com/coding/v1`:
- **Scale:** Extremely high generation speed (100 Tokens/s) and huge max inputs (262,144) designed implicitly for heavy automated agent frameworks.
- **Tool Mapping constraints:** Standard OpenAI bindings apply natively but with extreme scaling allowing up to 128 independent definitions in a single call. 
- **Session Rules:** Auth keys mapping active agents should keep watch for silent device detachment failures after 30 days.