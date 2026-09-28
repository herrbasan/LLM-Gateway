/**
 * Utilities for normalizing chat completion responses to match the strict
 * OpenAI format, ensuring all expected fields are present (e.g. refusal, system_fingerprint).
 */

/**
 * Adopt OpenRouter's reasoning alias.
 *
 * OpenRouter reports reasoning in a `reasoning` field, and the full trace in
 * `reasoning_details[]`, instead of OpenAI's `reasoning_content`. Unmapped, the
 * gateway cannot see that the model produced anything: the stream handler's
 * zero-content guard counts `reasoning_content` only, so a reasoning-only turn
 * is reported to the client as "Upstream returned no content" (502
 * ZERO_CONTENT) — and clients that read `reasoning_content` (VS Code Copilot)
 * never see the thinking at all. Mapping the alias here makes OpenRouter models
 * behave like every other reasoning provider (Kimi, DeepSeek) that already
 * sends `reasoning_content`.
 */
function adoptReasoningAlias(obj) {
    if (!obj || obj.reasoning_content !== undefined) return obj;
    const text = typeof obj.reasoning === 'string' && obj.reasoning.length > 0
        ? obj.reasoning
        : reasoningDetailsText(obj.reasoning_details);
    if (!text) return obj;
    return { ...obj, reasoning_content: text };
}

function reasoningDetailsText(details) {
    if (!Array.isArray(details)) return '';
    return details
        .map(d => (typeof d?.text === 'string' ? d.text : ''))
        .filter(Boolean)
        .join('\n');
}

/**
 * Normalize a complete chat completion response to OpenAI format.
 * Ensures all responses include refusal and system_fingerprint fields.
 */
export function normalizeResponse(response) {
    if (!response || !response.choices || !Array.isArray(response.choices)) {
        return response; // Pass through if no valid choices array
    }

    return {
        ...response,
        system_fingerprint: response.system_fingerprint ?? null,
        choices: response.choices.map(choice => ({
            ...choice,
            message: normalizeMessage(choice.message),
            logprobs: choice.logprobs ?? null,
            // If the model actually refused, the provider should have set refusal
            // Otherwise, default it to null
        }))
    };
}

/**
 * Normalize a streaming chunk to OpenAI format.
 * Ensures delta objects include refusal where appropriate.
 */
export function normalizeStreamChunk(chunk) {
    if (!chunk || !chunk.choices || !Array.isArray(chunk.choices)) {
        return chunk; // Pass through
    }

    return {
        ...chunk,
        system_fingerprint: chunk.system_fingerprint ?? null,
        choices: chunk.choices.map(choice => ({
            ...choice,
            logprobs: choice.logprobs ?? null,
            delta: normalizeDelta(choice.delta)
        }))
    };
}

/**
 * Normalize message object (for non-streaming responses).
 */
function normalizeMessage(message) {
    if (!message) return message;

    const normalized = adoptReasoningAlias({
        ...message,
        refusal: message.refusal ?? null,
        annotations: message.annotations ?? []
    });

    if (normalized.function_call === undefined) {
        normalized.function_call = null;
    }

    if (normalized.tool_calls === undefined) {
        normalized.tool_calls = null;
    }

    return normalized;
}

/**
 * Normalize delta object (for streaming responses).
 * We don't forcefully inject nulls into every delta, because streaming chunks are sparse.
 * But we can ensure fields are standardized if present.
 *
 * CRITICAL: Copilot's BYOK SSE parser accumulates only `delta.content`.
 * If a model emits chunks with `reasoning_content` but no `content` field
 * (Kimi K2.5, DeepSeek R1, Claude with thinking), Copilot sees zero
 * accumulated content and throws "Response contained no choices."
 * We inject `content: ""` so Copilot always has a content field to track.
 */
function normalizeDelta(delta) {
    if (!delta) return delta;

    const normalized = adoptReasoningAlias({ ...delta });

    if (delta.refusal !== undefined) {
        normalized.refusal = delta.refusal;
    }

    // Ensure content is present when reasoning_content exists,
    // so Copilot's BYOK consumer doesn't see an empty response.
    // Handles both missing (undefined) and explicitly null content.
    if (normalized.reasoning_content !== undefined && (normalized.content === undefined || normalized.content === null)) {
        normalized.content = "";
    }

    return normalized;
}
