/**
 * Utilities for normalizing chat completion responses to match the strict
 * OpenAI format, ensuring all expected fields are present (e.g. refusal, system_fingerprint).
 */

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

    const normalized = {
        ...message,
        refusal: message.refusal ?? null,
        annotations: message.annotations ?? []
    };

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
 */
function normalizeDelta(delta) {
    if (!delta) return delta;

    const normalized = { ...delta };
    
    if (delta.refusal !== undefined) {
        normalized.refusal = delta.refusal;
    }

    return normalized;
}
