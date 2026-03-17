# WebSocket Real-Time Mode: Test Strategy

This document outlines the comprehensive test strategy for validating the WebSocket Real-Time Mode implementation, organized by the major aspects and phases of development.

## 1. Connection & Security Testing (Phase 1 & 2)

**Goal:** Verify connection lifecycle management and basic security primitives.
* **IP Validation:** Unit test the IP validation middleware to ensure local IPs (`127.0.0.1`, `::1`) are accepted and external IPs are rejected with HTTP 1008 (Policy Violation) when `WS_LOCAL_ONLY` is true.
* **Upgrade Headers:** Test the HTTP to WebSocket upgrade handshake, ensuring missing or invalid `Sec-WebSocket-Key` or `Sec-WebSocket-Version` headers are handled correctly.
* **Authentication:** Verify that valid authentication details passed in the upgrade header or `session.initialize` payload are accepted, and invalid ones terminate the connection with a standard JSON-RPC error.
* **Connection Limits:** Integration tests to spawn `$MAX_LIMIT + 1` concurrent connections and verify the system proactively closes the excess connections to prevent resource exhaustion.

## 2. Protocol & State Machine Testing (Phase 1 & 3)

**Goal:** Ensure JSON-RPC 2.0 compliance, accurate request multiplexing, and robust state management.
* **JSON-RPC Validation:** Fuzz test the WebSocket message handler with malformed JSON, missing required fields (`jsonrpc`, `method`), and invalid types to ensure robust decoding and accurate `-32700` (Parse error) or `-32600` (Invalid Request) error responses.
* **Request Multiplexing:** E2E test sending multiple simultaneous requests (e.g., 5 concurrent `chat.create` calls) over a single connection. Verify that corresponding `chat.delta` and `chat.done` messages correlate flawlessly back to their respective Request IDs.
* **State Machine Transitions:** Unit test the Request State Machine (PENDING → PROCESSING → COMPLETED / CANCELLED / FAILED), ensuring invalid transitions throw internal errors before affecting the client.

## 3. Business Logic & Streaming (Phase 2 & 3)

**Goal:** Validate feature parity with HTTP SSE and incremental advanced features.
* **Stream Parity:** Integration tests checking that the sequence of tokens delivered via HTTP SSE matches identically with the payload of `chat.delta` on the WebSocket.
* **Cancellation Propagation:** E2E test that triggers `chat.cancel`. Verify that the WebSocket server immediately issues a `chat.done` with `cancelled: true` and that `AbortSignal` is triggered successfully on the downstream adapter (`fetch` call).
* **Context Buffering (`chat.append`):** Simulate a long conversational turn. Check the internal buffer token size. Submit a `chat.append` call and verify the gateway correctly compacts or reconstructs the full context before dispatching to the LLM.

## 4. Binary Protocol Testing (Phase 4)

**Goal:** Verify framing, decoding errors, and synchronization for audio/binary data.
* **Frame Decoding:** Feed the binary protocol decoder with mock byte arrays. Verify that stream IDs, timestamps, and sequence numbers are accurately decoupled from the payload.
* **Gap Detection:** Explicitly send binary frames out of sequence (`seq: 1`, then `seq: 3`). Ensure logs capture the skipped frames.
* **Format Negotiation:** Verify `audio.start` correctly rejects unsupported formats and establishes streams correctly for standard types (PCM16).

## 5. Non-functional & Resilience Testing (Phase 5)

**Goal:** Ensure production readiness, memory safety, and gracefully failing bounds.
* **Memory Leak Probing:** Hold thousands of idle WebSocket connections open for an extended duration while sampling heap size to guarantee no leaking closures or hanging connection contexts.
* **Backpressure Handling:** Flood the server with high-throughput streaming outputs to a slow-reading client mock. Verify the internal buffering correctly triggers backpressure limits or closes the connection if the buffer exceeds `highWaterMark`.
* **Graceful Shutdown:** Trigger a `SIGTERM` on the server while requests are in PROCESSING state. Verify the server stops accepting new connections, allows pending responses to finish (or timeout), and notifies clients gracefully before finally exiting.
