# LLM Gateway Specification Assessment

**Model**: GLM-5 (Zhipu AI)  
**Date**: 2026-03-01  
**Documents Reviewed**: `LLM_GATEWAY_SPEC.md`, `DEV_PLAN.md`

---

## Executive Summary

The LLM Gateway specification and development plan are well-structured and comprehensive. The core concept—OpenAI-compatible API with transparent context-window management via 202 Accepted + SSE progress—is elegant and pragmatic. However, several inconsistencies between documents and ambiguous implementation details need resolution before coding begins.

**Overall Rating**: 7.5/10 - Good foundation with actionable improvements needed

---

## Critical Issues

### 1. Phase Numbering Mismatch

The phase numbering between Spec and Dev Plan is misaligned:

| Spec Phase | Dev Plan Phase | Topic | Match |
|------------|----------------|-------|-------|
| 1 | 1 | Core Chat | ✓ |
| 2 | 5 | Streaming | ❌ |
| 3 | 4 | Tickets | ❌ |
| 4 | 4 | Compaction | ✓ |
| 5 | 6 | Sessions | ❌ |
| 6 | 7 | Embeddings | ❌ |
| 7 | 8 | Resilience | ❌ |

**Impact**: Implementation teams will reference wrong phases. Code reviews will be confusing.

**Recommendation**: Renumber Dev Plan phases to match Spec, or create explicit cross-reference table.

---

### 2. 202 Response Trigger Logic Inconsistency

**Spec (Lines 38-41)** states:
> Large (≥2000 tokens) → `202 Accepted`

**Spec (Lines 469-476)** shows:
```javascript
if (estimateTokens(prompt) >= minTokensToCompact && 
    estimateTokens(prompt) > (contextWindow - outputBuffer)) {
  return 202; // Async compaction needed
}
```

**Problem**: The code requires BOTH conditions. A 3000-token prompt in a 32k context window would return 200, not 202.

**Impact**: Clients expecting 202 for "large" prompts will receive 200, breaking assumptions.

**Recommendation**: Clarify exact trigger conditions. Either:
- Change table to say "Exceeds context window" instead of "≥2000 tokens"
- Change code to use OR logic
- Document that 2000 is a minimum threshold, not the sole criterion

---

### 3. Streaming Dependency Order

**Dev Plan** places streaming in Phase 5, but:
- Context compression (Phase 4) requires streaming for progress events
- Adapters (Phase 2) need `streamComplete()` generator pattern from day one

**Impact**: Phase 4 implementation will be blocked or require rework.

**Recommendation**: Move streaming infrastructure to Phase 2, alongside adapter development.

---

## Spec Issues (LLM_GATEWAY_SPEC.md)

### Missing Error Codes

The error handling table (Lines 555-564) is incomplete:

| Missing Code | Scenario |
|--------------|----------|
| `401 Unauthorized` | API key failures (Gemini) |
| `408 Request Timeout` | Client timeout during long operation |
| `503 Service Unavailable` | All providers down, circuit breakers open |

**Recommendation**: Add these codes with clear trigger conditions.

---

### Stream URL Behavior Undefined

Line 151 shows `"stream_url": "/v1/tasks/tkt_xyz789/stream"` but doesn't specify:

- Can clients reconnect mid-stream?
- What happens if client disconnects during compaction?
- Is there replay capability for missed events?
- How long is the stream URL valid?

**Recommendation**: Add "Stream Lifecycle" section documenting:
- Connection timeout behavior
- Reconnection strategy
- Event replay policy (none vs. last N events)

---

### Session Algorithm Edge Case

Lines 327-340 describe context management but don't address:

**What happens when `preserveLastN` messages still exceed context window?**

Example:
- Context window: 8k tokens
- `preserveLastN`: 4 exchanges
- Each exchange: 3k tokens
- Total: 12k tokens → exceeds window

**Recommendation**: Add fallback behavior:
1. Reduce `preserveLastN` progressively, OR
2. Truncate individual message content, OR
3. Return 413 with clear error message

---

### MVP Phasing Doesn't Match Dev Plan

Spec phases don't align with Dev Plan phases (see Critical Issue #1).

---

## Dev Plan Issues (DEV_PLAN.md)

### Token Estimation Strategy Undefined

Line 185 critiques the reference implementation:
```javascript
// BAD: Fixed heuristic (length/3) doesn't account for different tokenizers
```

But the proposed solution doesn't specify:
- Which tokenizer library? (tiktoken, gpt-tokenizer, provider-specific?)
- How to handle providers without tokenization APIs?
- Fallback strategy when tiktoken model is unknown?

**Recommendation**: Define explicit tokenization strategy:
```javascript
// Proposed approach:
// 1. Use provider's tokenizer API if available (Ollama, some cloud APIs)
// 2. Fall back to tiktoken with model-appropriate encoding
// 3. Final fallback: character heuristic (length/4 for code, length/3 for prose)
```

---

### Rolling Compression Missing Error Recovery

The `rollingCompress` function (Lines 655-688) has no error handling:

- What if chunk 3 of 5 fails?
- Is there checkpoint/resume capability?
- How to report partial progress on failure?
- Should already-processed chunks be cached?

**Recommendation**: Add error recovery strategy:
```javascript
// Option 1: Fail fast, discard all progress
// Option 2: Cache completed chunks, allow resume
// Option 3: Continue with partial summary, log warning
```

---

### Field Naming Inconsistency

| Location | Field Name | Style |
|----------|------------|-------|
| Line 562 | `preserveRecent` | camelCase |
| Line 931 | `preserve_recent` | snake_case |
| Line 559 | `compressionThreshold` | camelCase |
| Line 932 | `compression_threshold` | snake_case |

**Impact**: API consumers will encounter confusing errors.

**Recommendation**: Standardize:
- **JavaScript code**: camelCase
- **JSON API**: snake_case (matches OpenAI convention)
- Add explicit transformation layer in routes

---

### Circuit Breaker Implementation Incomplete

The `CircuitBreaker` class (Lines 752-775) references undefined methods:
- `onSuccess()` - referenced but not defined
- `onFailure()` - referenced but not defined

Also unclear:
- What happens in HALF_OPEN state?
- How many test requests allowed in HALF_OPEN?
- How does it transition back to CLOSED?

**Recommendation**: Complete implementation:
```javascript
class CircuitBreaker {
  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }
  
  onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
    }
  }
}
```

---

### No Persistence Strategy

Sessions are in-memory with 1h TTL. For production:

- What about horizontal scaling?
- Session recovery after restart?
- Multi-instance deployment?

**Recommendation**: Add section (even if "Future Enhancement"):
- Redis for distributed sessions
- SQLite for single-instance persistence
- Or explicitly document "single-instance only" limitation

---

### Missing Test Strategy

Checklists mention "Adapter tests" and "Comprehensive tests" but don't specify:
- Unit vs integration test split
- Mock provider strategy
- Coverage requirements
- CI/CD integration

**Recommendation**: Add Test Strategy section:
```
### Testing Approach
- Unit tests: Token estimation, chunking, compression algorithms
- Integration tests: Adapter protocols, streaming, session flow
- Mock providers: HTTP mock servers for LM Studio, Ollama, Gemini
- Coverage target: 80% for core modules
```

---

## Cross-Document Issues

### Terminology Drift

| Spec Term | Dev Plan Term | Recommendation |
|-----------|---------------|----------------|
| Compaction | Compression | Use "Compression" everywhere |
| Preserve last N | Preserve recent N | Use "Preserve recent N" |
| Ticket | Task | Use "Ticket" (matches URL pattern) |

**Recommendation**: Create terminology glossary and audit both documents.

---

### Response Format Inconsistency

**Spec (Line 139)** shows response with `provider` field:
```json
{
  "model": "qwen2.5-14b",
  "provider": "lmstudio",
  ...
}
```

**Dev Plan (Line 438)** shows response with `context` field but no `provider`:
```json
{
  "context": {
    "window_size": 32768,
    ...
  }
}
```

**Recommendation**: Both fields should be present in all chat completion responses.

---

## Summary of Recommendations

### High Priority (Fix Before Coding)
1. ✅ Align phase numbering between Spec and Dev Plan
2. ✅ Clarify 202 trigger conditions (exact logic)
3. ✅ Move streaming to Phase 2
4. ✅ Standardize naming conventions (camelCase code, snake_case JSON)

### Medium Priority (Fix During Implementation)
5. Add missing error codes (401, 408, 503)
6. Define stream URL lifecycle behavior
7. Complete CircuitBreaker implementation
8. Add error recovery to rolling compression
9. Define tokenization strategy

### Low Priority (Document for Future)
10. Add persistence strategy section
11. Define test strategy
12. Create terminology glossary
13. Add session algorithm edge case handling

---

## Strengths to Preserve

1. **Clear Core Concept** - 202 + SSE pattern is elegant
2. **Good Use Case Tables** - Tabular format removes ambiguity
3. **Pragmatic Configuration** - Sensible defaults with override capability
4. **Clean Adapter Interface** - Factory pattern with dependency injection
5. **Reference Analysis** - "Reference vs Our Approach" comparisons are invaluable
6. **Detailed Algorithms** - Pseudocode provides clear implementation guidance
7. **Modular File Structure** - Clean separation of concerns

---

## Conclusion

The specification is well-designed with a solid architectural foundation. The main issues are inconsistencies between documents rather than fundamental design flaws. Addressing the high-priority recommendations will significantly reduce implementation risk.

**Recommended Next Steps**:
1. Create unified terminology glossary
2. Update Dev Plan phase numbering
3. Clarify 202 trigger logic in Spec
4. Add streaming to Phase 2 in Dev Plan
5. Begin Phase 1 implementation
