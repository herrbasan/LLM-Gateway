// A simplified fast, purely native HTTP wrapper using standard fetch.

export async function request(url, options = {}) {
    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });

        if (!response.ok) {
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
        throw Object.assign(new Error(`Fetch error against ${url}: ${error.message}`), { code: error.code || 'FETCH_ERROR' });
    }
}
