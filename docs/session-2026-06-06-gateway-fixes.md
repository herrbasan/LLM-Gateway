# LLM Gateway Fixes & State

## Completed in this session:
- **VS Code Copilot Breakage (`Response contained no choices`) — FULLY FIXED (two rounds)**:
  1. Round 1: Removed dedicated `choices: []` usage chunk from SSE and `include_usage` forcing from all adapters (openai, alibaba, llamacpp).
  2. Round 2: Copilot token display showed "2.2k" because `stream_options` from Copilot's request was never forwarded upstream. No usage data reached Copilot.
  **Final fix**: Forward `request.stream_options` in openai/llamacpp/alibaba adapters. In SSE, transform `choices: []` + `usage` chunks to `choices: [{delta: {}, finish_reason: null}]` so usage telemetry reaches Copilot without crashing it.
- **AGENTS.md & copilot-instructions.md**: Updated adapter tables and all references to remove `kimi-cli`, `ollama`, `lmstudio`, `dashscope` — docs now match code reality.
- **chat.temp.js & adapters.md**: Stale files deleted.
- **Anthropic / GLM API Fix**: Added `maxTokens ?? 4096` fallback on Anthropic adapter.
- **Anthropic Adapter Streams**: Added explicit `!res.ok` check.
- **Legacy Adapters Purge**: `kimi-cli`, `lmstudio`, `ollama`, `dashscope` fully removed.
- **Context Compaction feature removal**: All deprecated compaction code stripped.

## Pending Issues:
1. **Copilot Context Display Bug (per-WebSocket)**: For WebSocket `chat.append`, token counts reset per-message instead of accumulating. Separate from the REST fix above — needs per-WebSocket `contextStats.usedTokens` tracking.
2. **Minimax M3 specific quirks**: Config already clamped to `512000`. No code-level guard yet.
3. **WebSocket Test Stability**: `chat.append` test occasionally times out due to listener cleanup.
4. **Duplicate Constructor False Alarm**: Erroneous note — no issue.
