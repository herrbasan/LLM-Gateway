// A simplified fast, purely native HTTP wrapper using standard fetch.

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_RETRY_OPTIONS = {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 10000,
    factor: 2,
    statusCodesToRetry: [429, 500, 502, 503, 504]
};

export async function request(url, options = {}) {
    const retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...(options.retry || {}) };
    let attempt = 0;

    const fetchOptions = { ...options };
    delete fetchOptions.retry;

    while (attempt <= retryOptions.maxRetries) {
        try {
            const response = await fetch(url, {
                ...fetchOptions,
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
            const isNetworkError = !error.status || error.name === 'TypeError' || error.code === 'ECONNREFUSED' || error.message.includes('fetch');
            const shouldRetry = (error.isRetriable || isNetworkError) && attempt < retryOptions.maxRetries;

            if (!shouldRetry) {
                if (error.status) {
                    throw error;
                }
                throw Object.assign(new Error(`Fetch error against ${url}: ${error.message}`), { code: error.code || 'FETCH_ERROR' });
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
