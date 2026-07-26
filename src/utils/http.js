// A simplified fast, purely native HTTP wrapper using standard fetch.

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Scrub credentials from URLs before they land in error messages (and from
// there, log files). Covers ?key= (Gemini), ?api_key=, ?access_token=, etc.
function sanitizeUrl(url) {
    try {
        const u = new URL(url);
        for (const param of ['key', 'api_key', 'apikey', 'access_token', 'token']) {
            if (u.searchParams.has(param)) u.searchParams.set(param, 'REDACTED');
        }
        return u.toString();
    } catch {
        return url;
    }
}

const DEFAULT_RETRY_OPTIONS = {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 10000,
    factor: 2,
    // Only genuine gateway-level transients are retried. 429 is a rate-limit
    // signal the circuit breaker must see (retrying hides + delays it). 500 on
    // a non-idempotent chat POST risks double token spend. Neither is retried.
    statusCodesToRetry: [502, 503, 504],
    // First-byte deadline: how long to wait for the response headers before
    // treating the upstream as hung. Per-read inter-chunk deadlines are the
    // SSE layer's concern, not this wrapper's.
    firstByteTimeoutMs: 60000
};

// True only for real transport failures — never for application bugs thrown
// inside the try block (which must not be retried).
function isNetworkError(error) {
    return error.name === 'TypeError'
        || error.code === 'ECONNREFUSED'
        || error.code === 'ECONNRESET'
        || error.code === 'ETIMEDOUT'
        || (typeof error.message === 'string' && error.message.includes('fetch failed'));
}

function createAbortError() {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

export function isAbortError(error) {
    return error?.name === 'AbortError'
        || error?.code === 'ABORT_ERR'
        || error?.message === 'Request aborted';
}

// Default mid-stream read deadline: an upstream that stops sending chunks but
// holds the connection open is hung. Reasoning models legitimately pause
// >60s between chunks, so this is a per-read deadline (reset each chunk), not
// a total stream timeout. Override via LLM_GW_STREAM_READ_DEADLINE_MS.
export const STREAM_READ_DEADLINE_MS =
    Number(process.env.LLM_GW_STREAM_READ_DEADLINE_MS) > 0
        ? Number(process.env.LLM_GW_STREAM_READ_DEADLINE_MS)
        : 120000;

/**
 * reader.read() with a deadline. If no chunk arrives within `ms`, the stream
 * is treated as hung: the reader is cancelled (which aborts the upstream
 * fetch body) and an UPSTREAM_TIMEOUT error is thrown. Per-read, so long
 * thinking pauses under the deadline are fine.
 */
export async function readWithDeadline(reader, ms = STREAM_READ_DEADLINE_MS) {
    let timer;
    try {
        return await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    // Cancel the underlying body so the upstream connection is torn down.
                    reader.cancel().catch(() => {});
                    const err = new Error(`Upstream stalled: no stream chunk within ${ms}ms`);
                    err.code = 'UPSTREAM_TIMEOUT';
                    reject(err);
                }, ms);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export async function request(url, options = {}) {
    const retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...(options.retry || {}) };
    let attempt = 0;

    const fetchOptions = { ...options };
    delete fetchOptions.retry;

    if (fetchOptions.signal?.aborted) {
        throw createAbortError();
    }

    while (attempt <= retryOptions.maxRetries) {
        // Compose the caller's abort signal with a first-byte deadline.
        // AbortSignal.any is Node >= 20.3; if the caller passed no signal, the
        // timeout alone guards against a hung upstream.
        const signals = [AbortSignal.timeout(retryOptions.firstByteTimeoutMs)];
        if (fetchOptions.signal) signals.push(fetchOptions.signal);
        const attemptSignal = AbortSignal.any(signals);

        try {
            const response = await fetch(url, {
                ...fetchOptions,
                signal: attemptSignal,
                headers: {
                    'Content-Type': 'application/json',
                    ...(fetchOptions.headers || {})
                }
            });

            if (!response.ok) {
                if (retryOptions.statusCodesToRetry.includes(response.status) && attempt < retryOptions.maxRetries) {
                    throw Object.assign(new Error(`Retriable HTTP status ${response.status}`), { status: response.status, isRetriable: true });
                }
                
                let errorText = response.statusText;
                try {
                    const errBody = await response.text();
                    errorText = `${errorText}: ${errBody}`;
                } catch (e) {
                    // Ignore text parse errors gracefully
                }
                throw Object.assign(new Error(`HTTP Error ${response.status}: ${errorText}`), { status: response.status });
            }

            return response;
        } catch (error) {
            // A genuine client abort (caller cancelled) must surface as an abort,
            // not be retried. Distinguish it from a first-byte timeout abort.
            if (fetchOptions.signal?.aborted) {
                throw createAbortError();
            }

            // First-byte deadline exceeded — the upstream accepted the connection
            // but never sent response headers. Retriable on early attempts, a
            // hung-upstream error on the final attempt.
            const isFirstByteTimeout = error.name === 'TimeoutError';

            const retriable = (error.isRetriable || isNetworkError(error) || isFirstByteTimeout)
                && attempt < retryOptions.maxRetries;

            if (!retriable) {
                if (error.status) {
                    throw error;
                }
                if (isFirstByteTimeout) {
                    throw Object.assign(
                        new Error(`Upstream hung: no response headers within ${retryOptions.firstByteTimeoutMs}ms from ${sanitizeUrl(url)}`),
                        { code: 'UPSTREAM_TIMEOUT' }
                    );
                }
                if (isAbortError(error)) {
                    throw createAbortError();
                }
                throw Object.assign(new Error(`Fetch error against ${sanitizeUrl(url)}: ${error.message}`), { code: error.code || 'FETCH_ERROR' });
            }

            let currentDelay = retryOptions.baseDelayMs * Math.pow(retryOptions.factor, attempt);
            currentDelay = Math.min(currentDelay, retryOptions.maxDelayMs);
            
            // Jitter calculation
            const jitter = currentDelay * 0.1 * (Math.random() * 2 - 1);
            currentDelay = Math.floor(currentDelay + jitter);

            await delay(currentDelay);
            attempt++;
        }
    }
}
