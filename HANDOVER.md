# Handover for Next Session

**Welcome to the LLM Gateway project!**

We have just completed Phase 1 (Foundation) and Phase 2 (Provider Adapter System). You are taking over right as we are ready to begin **Phase 3 (Intelligent Router)**.

## Project Context
The **LLM Gateway** is a centralized, OpenAI-compatible service that provides intelligent multi-provider routing (LM Studio, Ollama, Gemini) and handles massive text compaction transparently. 

**Our Guiding Principles:**
1. **Zero Defensive Coding:** Fail fast. Throw unhandled exceptions to reveal bugs rather than swallowing them.
2. **Minimal Dependencies:** Standard Node.js (`fetch`, ES Modules) + Express only.
3. **OpenAI SDK Friendly:** Keep payloads strictly shaped to the OpenAI standard coming in and out of the Gateway.
4. **Meaningful Testing Workflow:** Do NOT write purely synthetic unit tests or rely on mocking library stubs over everything. Tests must exercise real workflows (routing genuine payloads, hitting real endpoints or intentionally catching known error code paths like `ECONNREFUSED` if mock servers aren't running). 

## What’s Done
* **Project Scaffold**: `npm`, git, `ES Modules`. Express server is mounted in `src/server.js`.
* **Config Loader**: `src/config.js` properly extracts `.json` values and auto-subs OS environment variables.
* **Provider Adapters**: Under `src/adapters/`, we mapped LM Studio, Ollama, and Gemini instances to a uniform `base` contract. They parse standard inputs, route them out, transform stream/JSON results dynamically, and expose `models()`, `predict()`, `streamComplete()` and `embedText()`. 

## Your Task: Phase 3 (Intelligent Router)
You need to build `src/core/router.js`. This is the brain that distributes incoming `/v1/chat/completions` out to the right adapter.

**Key Router Requirements:**
1. **Adapter Registry & Fallback:** Initialize the `createAdapters` array from Phase 2. Make `config.routing.defaultProvider` the primary target.
2. **Namespaced Model Matching:** Support "provider:model" overrides (e.g. `X-Provider: lmstudio`, or setting `"model": "ollama:llama3"`) routing requests dynamically. 
3. **Structured Output Guarding:** If a client request includes `response_format` JSON schemas, verify that the selected provider has `capabilities.structuredOutput: true`. If not, throw an immediate semantic error instead of attempting the call. 
4. **Implement Real "Workflow" Tests:** Test the router by running real payloads through it, confirming if it blocks JSON on non-capable models without synthesizing mock objects just for coverage. 

**Quick Start Commands:**
- Boot Local Server: `npm start`
- Auto-Watch Testing: `npm run test:watch`

Check `docs/DEV_PLAN.md` and `docs/LLM_GATEWAY_SPEC.md` for a comprehensive architecture review! Good luck!