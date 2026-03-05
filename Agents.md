# LLM Gateway

The LLM Gateway is a centralized, OpenAI-compatible proxy and intelligent router for local and cloud LLM providers, built with Node.js and Express. It serves as a unified middleware layer capable of transparently managing context window limitations and routing requests across a variety of AI services.

## Core Capabilities

- **Unified OpenAI-Compatible API**
  Abstracts multiple downstream APIs (e.g., LM Studio, Ollama, OpenAI, Gemini, MiniMax, Kimi) into standard `/v1/chat/completions`, `/v1/embeddings`, and `/v1/models` endpoints, ensuring seamless integration with existing tools and SDKs.

- **Transparent Context Mitigation**
  Automatically intercepts prompts that exceed downstream token limits (preventing `413 Payload Too Large` errors) and applies configurable strategies like compaction, truncation, or sliding windows to fit the payload into the provider's context size.

- **Asynchronous Processing (`/v1/tasks`)**
  For massively large generation tasks, it features an asynchronous Ticket Registry. Clients passing `X-Async: true` receive a `202 Accepted` along with a ticket, enabling polling or SSE-based streaming to avoid long-running HTTP timeouts.

- **Stateful Session Management (`/v1/sessions`)**
  Manages conversational multi-turn context server-side. Sessions operate with sliding windows and TTL expirations, automatically maintaining relevant chat history via localized context summarization boundaries.

- **Resilience & Fault Tolerance**
  Implements the Circuit Breaker pattern with health checks (`/health`) and exponential backoffs to route around failed or congested local LLM endpoints gracefully, ensuring high reliability in production environments.
