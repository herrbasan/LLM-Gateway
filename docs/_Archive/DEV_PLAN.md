# LLM Gateway - Development Plan

> **Reference Material**: The `Reference/` folder contains adapter implementations from the mcp_server project. These are for **inspiration only** - we will significantly improve upon them.

> **Phase Numbering**: This document's phase numbering is canonical. LLM_GATEWAY_SPEC.md references these phases.

---

## Phase 1: Foundation (Core HTTP Server)

### Goals
- Express server with minimal dependencies
- Configuration system
- Basic error handling

### Reference
- None - fresh implementation needed

### Implementation Notes
- Use native `node:http` or Express (decision needed)
- Config validation on startup (fail-fast)
- No defensive try/catch without recovery

---

## Phase 2: Provider Adapter System

### Goals
- Clean adapter interface
- Multi-provider support (LM Studio, Ollama, Gemini)
- Model resolution strategies

### Reference Files
- `Reference/adapters/lmstudio.js` - Basic structure
- `Reference/adapters/ollama.js` - Model resolution pattern
- `Reference/adapters/gemini.js` - API key handling

### Improvements Over Reference

| Aspect | Reference Implementation | Our Approach |
|--------|-------------------------|--------------|
| **Error Handling** | Generic error messages | Provider-specific error codes, retryable vs fatal |
| **Model Resolution** | Ad hoc per adapter | Unified resolver with caching |
| **Streaming** | Not implemented | First-class streaming support from day one |
| **Rate Limiting** | None | Per-adapter rate limiter with queue |
| **Health Checks** | Basic | Deep health with model warmup verification |

### Adapter Interface (Improved)

```javascript
// vs Reference/router.js - factories are inline and messy
// Our version: Clean separation, dependency injection

export function createAdapter(config, deps) {
  return {
    name: 'provider-name',
    
    // Capabilities declaration
    capabilities: {
      embeddings: boolean,
      streaming: boolean,
      structuredOutput: boolean,
      modelManagement: boolean  // load/unload
    },
    
    // Model resolution with caching
    async resolveModel(preferred) { },
    getModel() { },
    
    // Core methods - all return standardized format
    async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) { },
    async *streamComplete({ ... }) { yield token; },  // Generator!
    
    // Embeddings
    async embedText(text, model) { },
    async embedBatch(texts, model) { },
    
    // Introspection
    async listModels() { },
    async getContextWindow() { },
    async healthCheck() { },  // NEW: Deep health check
    
    // Lifecycle (optional)
    async loadModel(name) { },
    async unloadModel(name) { },
    
    // NEW: Metrics for monitoring
    getMetrics() { return { requests, errors, latency }; }
  };
}
```

---

## Phase 3: Intelligent Router

### Goals
- Route requests to appropriate provider
- Handle model namespacing (`provider:model`)
- Fallback strategies
- Structured output guard: reject routing `response_format` requests to providers without `structuredOutput` capability

### Reference Files
- `Reference/router.js` - Basic routing logic
- `Reference/context-manager.js` - Token management

### Improvements Over Reference

#### Reference Issues (router.js)
```javascript
// BAD: Inline factory registry, messy config handling
const PROVIDER_FACTORIES = { lmstudio: (config) => ({...}) };

// BAD: Lazy initialization in predict() causes first-request latency
function initializeProvider(providerName) { ... }

// BAD: Manual metadata refresh logic scattered
const refreshMetadata = async (providerName) => { ... };
```

#### Our Approach
```javascript
// Router with dependency injection, eager warmup
export function createRouter(config, deps) {
  // Pre-initialized adapters at startup
  const adapters = new Map();
  const pools = new Map();  // Connection pools per provider
  
  // Health monitoring background task
  const healthMonitor = createHealthMonitor(adapters);
  
  // Model resolution cache with TTL
  const modelCache = createCache({ ttl: 60000 });
  
  return {
    // Synchronous - adapters pre-initialized
    getAdapter(provider) { },
    
    // Provider selection with fallback chain
    async route(request) {
      // 1. Parse model (provider:model or just model)
      // 2. Check provider health
      // 3. If request has response_format, filter to structuredOutput-capable providers
      // 4. Apply fallback if needed
      // 5. Return selected adapter
    },
    
    // NEW: Circuit breaker pattern
    getCircuitState(provider) { },
    
    // NEW: Metrics aggregation
    getMetrics() { }
  };
}
```

---

## Phase 4: Context Window Management

### Goals
- Handle oversized prompts gracefully
- Token estimation per provider
- Progress tracking for long compression jobs
- Pluggable context strategies

### Terminology

| Term | Definition |
|------|------------|
| **Context Window** | Maximum tokens a model can process (input + output) |
| **Available Tokens** | Context window minus output buffer |
| **Context Strategy** | How to handle prompts exceeding available tokens |
| **Sliding Window** | Truncate oldest messages, keep recent N |
| **Compression** | LLM-based summarization of older content |

### Reference Files
- `Reference/context-manager.js` - Basic compaction trigger
- `Reference/chunk.js` - Text chunking
- `Reference/compact.js` - Rolling compaction
- `Reference/tokenize.js` - Token estimation

### Improvements Over Reference

#### Reference Issues (context-manager.js)
```javascript
// BAD: Fixed heuristic (length/3) doesn't account for different tokenizers
export function estimateTokens(text) {
  return { tokens: Math.ceil(text.length / 3) };
}

// BAD: Compression happens inline, blocking the request
async compact(text, availableTokens) {
  const { chunks } = chunkText(text, safeAvailable);
  const { summaries } = await rollingCompact(chunks, ...);  // BLOCKING
  return summaries[summaries.length - 1];
}
```

#### Our Approach
```javascript
// Tiered token estimation per provider (they use different tokenizers)
// Priority: 1. Provider API (e.g., Gemini countTokens)
//           2. tiktoken with appropriate encoding (cl100k_base, etc.)
//           3. Character heuristic (length * fallbackRatio)
export function createTokenizer(provider, model) {
  // Use provider's tokenizer when available
  // Fallback to tiktoken or heuristic
  return {
    estimate(text) { },
    count(text) { return provider.countTokens?.(text); }
  };
}

// Decision: Which strategy to apply?
function selectStrategy(prompt, strategy, contextWindow, outputBuffer) {
  const tokens = estimateTokens(prompt);
  const availableTokens = contextWindow - outputBuffer;
  
  // Check if it fits as-is
  const fits = tokens <= availableTokens;
  
  // Configured mode (default: 'truncate')
  const mode = strategy?.mode ?? 'truncate';
  
  if (fits) {
    // Fits: no strategy needed
    return 'none';
  }
  
  // Doesn't fit
  if (mode === 'none') {
    // User explicitly disabled handling - will throw 413
    return 'none';
  }
  
  // Apply configured strategy
  // Default behavior: compact transparently and return 200
  // With X-Async: true: return 202 + ticket
  return mode;  // 'truncate' | 'rolling' | 'compress'
}

// Preserve-Last-N Fallback Matrix
// When last N exchanges alone exceed available context:
// 1. Dynamically reduce N until content fits (minimum N=1)
// 2. If N=1 still exceeds: truncate oldest message content in preserved set
// 3. If system prompt alone exceeds: return 413 Payload Too Large

// targetRatio (config: compaction.targetRatio)
// Target compression ratio. 0.3 = compress to ~30% of original token count.
// Used to determine when a compaction summary is sufficiently reduced.

// Strategy 1: Truncate (Sliding Window) - DEFAULT
// - Drop oldest messages
// - Preserve system prompt + recent N exchanges
// - Synchronous, immediate
// - Use case: Quick handling of oversized prompts

// Strategy 2: Rolling Compression (chained summaries)
// PRIMARY USE: One-shot large document processing
// - Split content into chunks
// - Process chunk 1 → Summary 1
// - Process chunk 2 + Summary 1 → Summary 2 (accumulated)
// - Preserves cross-references across the entire document
// - Async with progress events
//
// SECONDARY USE: Session compaction strategy
// - When session history grows too large
// - Compress older messages with rolling method
// - Preserves conversation flow and references

// Strategy 3: Compress (Single-pass Summarization)
// - One-shot summarization of all content
// - Faster but may lose cross-chunk references
// - Async for large inputs, with ticket + SSE progress

// Strategy 4: None (opt-out)
// - Send as-is
// - Returns 413 Payload Too Large if exceeds context window
// - Use case: When exact content preservation is critical
```

---

## Phase 5: Unified Streaming Architecture

### Goals
- Single SSE mechanism for all responses
- Small prompts: stream tokens immediately
- Large prompts: stream compression progress then tokens
- SSE backpressure handling to prevent memory exhaustion

### Reference
- None - streaming not implemented in reference

### Backpressure

SSE connections buffer events in memory if the client reads slowly. Mitigations:
- Cap internal event buffer per connection (configurable, default: 1000 events)
- Emit periodic heartbeat comments (`: heartbeat`) to detect stale connections (configurable interval, default: 15s)
- Drop connection if buffer exceeds cap
- For non-streaming compaction (default 200 path), backpressure is not an issue since the response is a single JSON payload

### Design

```
┌─────────────────────────────────────────────────────────┐
│                    Client Request                       │
│  POST /v1/chat/completions (Accept: text/event-stream) │
│  With optional:                                         │
│    - context_strategy (per-request)                     │
│    - X-Session-Id header (stateful mode)                │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  Streaming Handler                      │
│  ┌─────────────┐    ┌─────────────┐    ┌────────────┐  │
│  │   Context   │───▶│ Compression │───▶│  Token Gen │  │
│  │   Strategy  │    │   (opt)     │    │   Stream   │  │
│  └─────────────┘    └─────────────┘    └────────────┘  │
│  - truncate         - async ticket     - SSE tokens     │
│  - sliding window   - progress         - final stats    │
└─────────────────────────────────────────────────────────┘
```

#### Request Flow

```javascript
// 1. Stateless + No Strategy (default)
POST /v1/chat/completions
{ "messages": [...], "stream": true }
// → Immediate token streaming

// 2. Stateless + Truncate (Sliding Window) - DEFAULT
POST /v1/chat/completions
{
  "messages": [/* 45k tokens */],
  "stream": true
  // No context_strategy needed - truncate is default
}
// → Server applies sliding window
// → Immediate token streaming with context header

// 3. Stateless + Rolling Compression (for docs with references)
POST /v1/chat/completions
{
  "messages": [/* 100k tokens, document with cross-references */],
  "stream": true,
  "context_strategy": {
    "mode": "rolling",
    "chunk_size": 8000
  }
}
// → Rolling compression events (chained summaries)
// → Then token streaming

// 4. Stateless + Single-pass Compression
POST /v1/chat/completions
{
  "messages": [/* 45k tokens */],
  "stream": true,
  "context_strategy": { "mode": "compress" }
}
// → Compression progress events
// → Then token streaming

// 4. Stateful Session
POST /v1/chat/completions
Headers: X-Session-Id: sess_xxx
{ "messages": [{"role":"user","content":"follow up"}], "stream": true }
// → Session history retrieved
// → Session strategy applied if needed
// → Token streaming with session stats
```

#### Event Types

```
# Context Strategy Phase (optional, per-request)
event: context.truncate
data: {"original_messages":50,"retained_messages":10,"strategy":"truncate"}

# Rolling Compression Phase (for large single documents)
event: compression.rolling.start
data: {"ticket":"tkt_xxx","total_chunks":5,"chunk_size":8000}

event: compression.rolling.progress
data: {"ticket":"tkt_xxx","chunk":2,"total":5,"accumulated_summary_tokens":2500}

event: compression.rolling.complete
data: {"ticket":"tkt_xxx","original_tokens":45000,"final_tokens":4200,"chunks_processed":5}

# Single-pass Compression Phase (optional, async)
event: compression.start
data: {"ticket":"tkt_xxx","estimated_chunks":5}

event: compression.progress
data: {"ticket":"tkt_xxx","chunk":2,"total":5,"tokens_reduced":15000}

event: compression.complete
data: {"ticket":"tkt_xxx","original_tokens":45000,"final_tokens":2800}

# Token Generation Phase (all requests)
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":" world"}}]}

# Final Event
event: context.status                 # Context window status
data: {"window_size":32768,"used_tokens":1250,"available_tokens":31518}

data: [DONE]

# Errors
event: error
data: {"error":{"type":"provider_error","message":"..."}}
```

---

## Phase 6: Conversation Management (Stateless by Default)

### Design Philosophy
- **Stateless (default)**: Each request is independent, no server-side state
- **Stateful Sessions**: Explicit opt-in for multi-turn conversations
- **Context Strategies**: Pluggable strategies for handling long contexts

### Terminology

| Term | Description |
|------|-------------|
| **Stateless** | No server-side state (default) |
| **Stateful Session** | Server stores conversation history |
| **Context Truncation** | Drop oldest messages (sliding window) |
| **Context Compression** | Summarize old messages via LLM |
| **Context Window** | Maximum tokens a model can process |

### Endpoint Behavior

```
POST /v1/chat/completions          # Stateless (default)
POST /v1/chat/completions          # With X-Session-Id = stateful session
POST /v1/sessions                  # Create stateful session
```

### Stateless Mode (Default)

```javascript
// Single request, no state stored
POST /v1/chat/completions
{
  "model": "lmstudio:qwen2.5-14b",
  "messages": [
    {"role": "system", "content": "You are helpful"},
    {"role": "user", "content": "Hello"}
  ]
}

// Response includes context window info
{
  "choices": [...],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 150,
    "total_tokens": 175
  },
  "context": {                    // Context window status
    "window_size": 32768,
    "used_tokens": 175,
    "remaining_tokens": 32593,
    "truncation_applied": false
  }
}
```

### Context Handling Strategies (Per-Request)

Applied to any request (stateless OR stateful):

```javascript
POST /v1/chat/completions
{
  "model": "lmstudio:qwen2.5-14b",
  "messages": [/* 45k tokens */],
  "context_strategy": {           // Per-request strategy
    "mode": "truncate",           // "none" | "truncate" | "compress"
    "preserve_recent": 4,         // Keep last N exchanges
    "max_tokens": 28000           // Target size
  }
}
```

| Mode | Behavior | Default? | Use Case |
|------|----------|----------|----------|
| `truncate` | **Sliding window**: Drop oldest messages | ✅ **Default** | Quick handling of oversized prompts |
| `rolling` | **Rolling compression**: Chained summaries | No | Large docs, long conversations |
| `compress` | **Single-pass**: One-shot summarization | No | General compression |
| `none` | Send as-is, return 413 if too large | Opt-out | Exact preservation required |

### Stateful Sessions

#### Creating a Session

```javascript
POST /v1/sessions
{
  "context_strategy": {           // Session-level default
    "mode": "truncate",
    "preserve_recent": 4,
    "compression_threshold": 0.8  // Compress at 80% capacity
  },
  "ttl_minutes": 60               // Optional, default 60
}

// Response
{
  "session_id": "sess_abc123",
  "created_at": "2026-03-01T12:00:00Z",
  "expires_at": "2026-03-01T13:00:00Z",
  "context_strategy": {...}
}
```

#### Using a Session

```javascript
POST /v1/chat/completions
Headers: X-Session-Id: sess_abc123

{
  "model": "auto",
  "messages": [{"role": "user", "content": "Follow-up question"}]
  // Server appends to stored conversation history
}

// Response includes session context
{
  "choices": [...],
  "usage": {...},
  "session": {                    // Session context reporting
    "id": "sess_abc123",
    "message_count": 5,
    "context": {
      "window_size": 32768,
      "used_tokens": 2450,
      "available_tokens": 30318,
      "compression_count": 0,
      "strategy": "truncate"
    }
  }
}
```

#### Session Compaction Strategies

Sessions can use any context strategy when history grows:

| Strategy | When Applied | Best For |
|----------|--------------|----------|
| `truncate` | Automatically when >80% capacity | Fast, minimal latency |
| `rolling` | On-demand or scheduled | Long conversations with references |
| `compress` | On-demand or scheduled | Quick summary of old messages |

**Session + Compaction Interaction:**
- On successful compaction: the compacted summary replaces older messages in the session store
- On compaction failure: fall back to truncation (drop oldest, keep recent N), log the failure, do not block the request
- The `compression_count` in session metadata tracks how many times compaction has been applied

```javascript
// Force rolling compression on session
POST /v1/sessions/sess_abc123/compress
{
  "strategy": "rolling",
  "preserve_recent": 6
}
// → Compresses older messages, keeps recent 6 exchanges
// → Returns new available_tokens count
```

#### Session Structure

```javascript
{
  id: 'sess_abc123',
  createdAt: Date,
  expiresAt: Date,
  lastActivity: Date,
  contextStrategy: {
    mode: 'truncate',             // 'none' | 'truncate' | 'rolling' | 'compress'
    preserveRecent: 4,            // Recent exchanges to keep
    chunkSize: 8000,              // For rolling compression
    compressionThreshold: 0.8     // Trigger compression at 80%
  },
  messages: [
    { role: 'system', content: '...', preserved: true },
    { role: 'user', content: '...', tokens: 15, timestamp: Date },
    { role: 'assistant', content: '...', tokens: 150, timestamp: Date },
    // ... managed by context strategy
  ],
  summary: null,                  // Compressed summary of older messages
  metadata: {
    totalTokens: 2450,
    compressionCount: 0,
    availableTokens: 30318
  }
}
```

### Context Strategy Algorithm

```javascript
function buildContext(history, strategy, config) {
  const {
    mode = 'none',
    preserveRecent = 4,
    maxTokens = config.contextWindow * 0.85
  } = strategy;
  
  const contextWindow = config.contextWindow;
  const outputBuffer = config.outputBuffer || 2000;
  const availableTokens = contextWindow - outputBuffer;
  
  // Calculate current token usage
  const currentTokens = calculateTokens(history);
  
  // No strategy needed
  if (mode === 'none' || currentTokens <= maxTokens) {
    return {
      messages: history,
      strategy_applied: false,
      available_tokens: availableTokens - currentTokens
    };
  }
  
  // Truncate: Sliding window - keep recent N exchanges
  if (mode === 'truncate') {
    const preserved = extractRecentExchanges(history, preserveRecent);
    const remainingBudget = availableTokens - calculateTokens(preserved);
    
    return {
      messages: preserved,
      strategy_applied: 'truncate',
      dropped_messages: countDropped(history, preserved),
      available_tokens: remainingBudget
    };
  }
  
  // Rolling: Chained compression for large single documents
  if (mode === 'rolling') {
    // Split into chunks, process with accumulating summary
    const { result, summaries } = await rollingCompress(
      history,
      availableTokens,
      config.chunkSize
    );
    
    return {
      messages: result,
      strategy_applied: 'rolling',
      chunks_processed: summaries.length,
      available_tokens: availableTokens - calculateTokens(result)
    };
  }
  
  // Compress: Single-pass summarization
  if (mode === 'compress') {
    const { compressed, summary } = await compressHistory(
      history,
      preserveRecent,
      availableTokens
    );
    
    return {
      messages: compressed,
      strategy_applied: 'compress',
      summary,
      available_tokens: availableTokens - calculateTokens(compressed)
    };
  }
}

### Rolling Compression Algorithm

```javascript
// Rolling compression preserves cross-chunk references
// by chaining summaries through the document

async function rollingCompress(content, availableTokens, chunkSize) {
  const chunks = splitIntoChunks(content, chunkSize);
  const summaries = [];
  let accumulatedSummary = '';
  
  for (let i = 0; i < chunks.length; i++) {
    // Each chunk gets the accumulated context from previous chunks
    const input = accumulatedSummary 
      ? `[PREVIOUS CONTEXT]\n${accumulatedSummary}\n\n[NEW CONTENT]\n${chunks[i]}`
      : chunks[i];
    
    // Summarize this chunk with context
    const summary = await summarizeChunk(input, availableTokens);
    
    accumulatedSummary = summary;
    summaries.push({
      chunk: i + 1,
      summary_tokens: estimateTokens(summary),
      input_tokens: estimateTokens(input)
    });
    
    // Report progress for streaming
    if (onProgress) {
      onProgress(i + 1, chunks.length, accumulatedSummary);
    }
  }
  
  // Final result is the accumulated summary of all chunks
  return {
    result: accumulatedSummary,
    summaries
  };
}
```

### Session API Endpoints

```
POST   /v1/sessions                  # Create stateful session
GET    /v1/sessions/:id              # Get session info (with context stats)
PATCH  /v1/sessions/:id              # Update context strategy
DELETE /v1/sessions/:id              # Delete session
POST   /v1/sessions/:id/compress     # Force compression
```

---

## Phase 7: Embeddings Endpoint

### Goals
- OpenAI-compatible `/v1/embeddings`
- Batch support
- Provider routing for embeddings

### Embedding Provider Routing Precedence
1. If request specifies a namespaced model (e.g., `ollama:nomic-embed`), route to that provider
2. If request specifies a plain model name, search all providers with `embeddings: true` capability
3. Fall back to `routing.embeddingProvider` config value
4. Fall back to `routing.defaultProvider` if it has `embeddings: true`

### Reference Files
- `Reference/adapters/lmstudio.js` - `embedText()`, `embedBatch()`
- `Reference/adapters/ollama.js` - Ollama embedding API

### Improvements
- Queue for large batch requests
- Caching for repeated texts
- Dimension validation per model

---

## Phase 8: Resilience & Production Readiness

### Goals
- Retry with exponential backoff
- Circuit breaker pattern
- Connection pooling
- Metrics and monitoring

### Reference Issues
- Reference has no retry logic
- No circuit breaker
- No connection pooling
- Manual error handling everywhere

### Our Implementation

```javascript
// Retry decorator for adapter methods
function withRetry(fn, options) {
  return async (...args) => {
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      try {
        return await fn(...args);
      } catch (err) {
        if (!isRetryable(err) || attempt === options.maxAttempts) throw;
        await sleep(options.backoffMs * Math.pow(2, attempt - 1));
      }
    }
  };
}

// Circuit breaker
class CircuitBreaker {
  constructor(threshold = 5, timeout = 30000) {
    this.failures = 0;
    this.state = 'CLOSED';  // CLOSED, OPEN, HALF_OPEN
  }
  
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure < this.timeout) {
        throw new Error('Circuit breaker open');
      }
      this.state = 'HALF_OPEN';
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }
}
```

---

## File Structure

```
src/
├── main.js                    # Entry point
├── config.js                  # Config loading & validation
├── server.js                  # HTTP server setup
│
├── routes/                    # Route handlers
│   ├── completions.js         # POST /v1/chat/completions
│   ├── embeddings.js          # POST /v1/embeddings
│   ├── models.js              # GET /v1/models
│   ├── sessions.js            # POST /v1/sessions
│   ├── health.js              # GET /health
│   └── stream.js              # GET /v1/tasks/:id/stream
│
├── core/                      # Core logic
│   ├── router.js              # Provider routing (improved from Reference)
│   ├── ticket-registry.js     # Async task tracking
│   ├── session-store.js       # Session management
│   └── circuit-breaker.js     # Resilience patterns
│
├── adapters/                  # Provider adapters (improved from Reference)
│   ├── index.js               # Adapter registry
│   ├── base.js                # Base adapter interface
│   ├── lmstudio.js            # LM Studio adapter
│   ├── ollama.js              # Ollama adapter
│   └── gemini.js              # Gemini adapter
│
├── context/                   # Context window management
│   ├── estimator.js           # Token estimation
│   ├── chunker.js             # Text chunking
│   ├── rolling.js             # Rolling compression (chained summaries)
│   ├── compressor.js          # Single-pass compression
│   └── worker.js              # Background compression worker
│
├── streaming/                 # Streaming support
│   ├── sse.js                 # SSE response handler
│   ├── bridge.js              # Compaction → Token bridge
│   └── multiplexer.js         # Multi-client support
│
└── utils/
    ├── fn.js                  # Functional utilities
    ├── cache.js               # TTL cache
    └── errors.js              # Error types
```

---

## Development Checklist

### Phase 1
- [ ] Project setup (package.json, entry point)
- [ ] Config schema and validation
- [ ] Basic Express server
- [ ] Health endpoint

### Phase 2
- [ ] Base adapter interface
- [ ] LM Studio adapter (with streaming)
- [ ] Ollama adapter
- [ ] Gemini adapter
- [ ] Adapter tests

### Phase 3
- [ ] Router with provider resolution
- [ ] Model namespacing (`provider:model`)
- [ ] Structured output guard (reject `response_format` to non-capable providers)
- [ ] Health monitoring
- [ ] Circuit breaker

### Phase 4: Context Window Management
- [ ] Tiered token estimation (provider API → tiktoken → heuristic)
- [ ] Chunking algorithm with smart boundaries
- [ ] **Rolling compression** (chained summaries across chunks)
- [ ] Single-pass compression with progress callbacks
- [ ] **Context strategies**: `none`, `truncate`, `rolling`, `compress`
- [ ] Preserve-last-N fallback matrix (dynamic N reduction, 413 for system-prompt overflow)
- [ ] Transparent compaction (default: block and return 200)
- [ ] Ticket registry for async compression jobs (`X-Async: true` opt-in)
- [ ] `targetRatio` enforcement in compaction
- [ ] Context window reporting in responses

### Phase 5: Unified Streaming
- [ ] SSE streaming infrastructure
- [ ] Heartbeat comments (`: heartbeat`) for long-lived connections
- [ ] SSE backpressure handling (capped event buffer, stale connection detection)
- [ ] **Truncation events** for sliding window mode
- [ ] Compression progress streaming
- [ ] Token streaming with context status event
- [ ] Error handling in streams

### Phase 6: Conversation Management (Stateless Default)
- [ ] **Stateless mode** (default)
- [ ] **Session creation** with context strategy parameter
- [ ] **X-Session-Id header** for stateful mode
- [ ] Conversation history accumulation
- [ ] **Session context reporting** (available tokens, compression count)
- [ ] Session compaction failure recovery (fall back to truncation)
- [ ] Compacted summary replaces older messages in session store
- [ ] PATCH /v1/sessions/:id to update strategy
- [ ] TTL cleanup

### Phase 7
- [ ] Embeddings endpoint
- [ ] Batch embedding support
- [ ] Embedding provider routing precedence (namespaced model → capable providers → embeddingProvider → defaultProvider)

### Phase 8
- [ ] Retry with backoff
- [ ] Connection pooling
- [ ] Metrics collection
- [ ] Comprehensive tests

---

## Development Philosophy

### Fail-Fast
- Uncaught exceptions reveal bugs - no defensive catches
- Fix the cause, not the symptom

### Testing Pattern (Meaningful Tests)
- Write meaningful integration and unit tests for every functional unit
- **Automatically run the tests (`npm test`) to verify the work before moving on to the next phase.**
- **Avoid mock data whenever possible**: Test against real configurations, local files, and real data workflows.
- If mocks must be used (e.g., to simulate external API responses before an integration exists), **remove mock data as soon as real data workflows become available**. 
- Tests should validate true end-to-end behavior inside the environment boundary.

### Code Style
- No comments - code must be self-evident
- Functional preference
- Reliability > Performance > Human Readability
2. **Streaming First**: All adapters must support streaming from the start
3. **Fail-Fast**: Uncaught exceptions reveal bugs - no defensive catches
4. **No Comments**: Code must be self-evident
5. **Functional Preference**: Pure functions where possible
6. **No Build Step**: Vanilla JavaScript, native modules
7. **Field Naming Convention**: camelCase internally, snake_case in API payloads (OpenAI convention), X-Kebab-Case for custom headers. Translation at the route handler boundary.
8. **Structured Output Guard**: Requests with `response_format` are only routed to providers advertising `structuredOutput: true`. Plain text requests can go to any provider.

---

## Reference Files Summary

| Reference File | Purpose | What to Improve |
|---------------|---------|-----------------|
| `router.js` | Provider routing | DI, circuit breaker, eager init |
| `adapters/lmstudio.js` | LM Studio adapter | Add streaming, metrics, better errors |
| `adapters/ollama.js` | Ollama adapter | Add streaming, connection pool |
| `adapters/gemini.js` | Gemini adapter | Add streaming, rate limiting |
| `context-manager.js` | Compaction trigger | Async tickets, better token estimation |
| `chunk.js` | Text chunking | Smarter boundaries (paragraphs) |
| `compact.js` | Compression/summarization | Progress callbacks, worker pool |
| `tokenize.js` | Token estimation | Per-provider tokenizers |
| `formatter.js` | Output formatting | Streaming-safe processing |

---

## Summary: Context Strategies

### Stateless Mode (Default: Truncate)
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `context_strategy` | object | `{mode: "truncate"}` | Per-request context handling |
| `context_strategy.mode` | string | `"truncate"` | `"truncate"` (default), `"rolling"`, `"compress"`, or `"none"` |
| `context_strategy.preserve_recent` | number | `4` | Recent exchanges to keep |
| `context_strategy.max_tokens` | number | `0.85 * contextWindow` | Target token count |
| `context_strategy.chunk_size` | number | `8000` | Chunk size for rolling mode |

**Response includes:** `context.window_size`, `context.used_tokens`, `context.available_tokens`

### Stateful Session
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `context_strategy.mode` | string | `"truncate"` | Session default strategy |
| `context_strategy.preserve_recent` | number | `4` | Recent exchanges to keep |
| `context_strategy.compression_threshold` | number | `0.8` | Compress at % capacity |
| `ttl_minutes` | number | `60` | Session lifetime |

**Usage:** Create with `POST /v1/sessions`, then use with `X-Session-Id` header

**Response includes:** `session.context.available_tokens`, `session.context.compression_count`

### Default Behavior

**By default**, all requests use `truncate` (sliding window) if the prompt exceeds the context window:
- Oldest messages are dropped
- System prompt is preserved
- Most recent N exchanges are preserved
- Response indicates truncation was applied

**To disable automatic truncation**, explicitly set:
```json
{"context_strategy": {"mode": "none"}}
```
This will return HTTP 413 if the prompt is too large.

### Comparison

| Feature | Stateless (Truncate Default) | Stateless (Custom) | Stateful Session |
|---------|------------------------------|-------------------|------------------|
| Server state | None | None | Conversation history |
| Default strategy | `truncate` | As specified | `truncate` (configurable) |
| Multi-turn | Manual | Manual | Automatic |
| Context reporting | Yes | Yes | Yes |
| Strategy trigger | Auto if oversized | Per-request | Auto at threshold |
| 413 error possible | Only if mode=none | Only if mode=none | No (auto-handled) |

### Terminology Reference

| Old Term | New Term | Meaning |
|----------|----------|---------|
| Fleeting | Stateless | No server-side conversation state |
| Persistent | Stateful | Server stores conversation history |
| Rolling window | Truncate / Sliding window | Drop oldest messages |
| Compaction | Compression | LLM-based summarization |
| Preserve last N | Preserve recent N | Keep N most recent exchanges |
