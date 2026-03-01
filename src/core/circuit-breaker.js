export class CircuitBreaker {
    constructor(name, threshold = 3, resetTimeoutMs = 30000) {
        this.name = name;
        this.failureThreshold = threshold;
        this.resetTimeoutMs = resetTimeoutMs;
        
        this.state = 'CLOSED'; // 'CLOSED', 'OPEN', 'HALF-OPEN'
        this.failures = 0;
        this.lastFailureTime = null;

        // Metrics for /health
        this.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            shortCircuitedRequests: 0
        };
    }

    getStats() {
        return {
            state: this.state,
            failures: this.failures,
            ...this.metrics
        };
    }

    async fire(action) {
        this.metrics.totalRequests++;

        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
                this.state = 'HALF-OPEN';
            } else {
                this.metrics.shortCircuitedRequests++;
                const err = new Error(`[CircuitBreaker] Fast fail: Circuit is OPEN for provider '${this.name}'`);
                err.status = 503;
                throw err;
            }
        }

        try {
            const result = await action();
            this.onSuccess();
            return result;
        } catch (error) {
            if (this.isTrippableError(error)) {
                this.onFailure();
            } else {
                this.onSuccess();
            }
            throw error;
        }
    }

    async *fireStream(action) {
        this.metrics.totalRequests++;

        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
                this.state = 'HALF-OPEN';
            } else {
                this.metrics.shortCircuitedRequests++;
                const err = new Error(`[CircuitBreaker] Fast fail: Circuit is OPEN for provider '${this.name}'`);
                err.status = 503;
                throw err;
            }
        }

        let streamStarted = false;
        try {
            const stream = action();
            for await (const chunk of stream) {
                if (!streamStarted) {
                    streamStarted = true;
                    this.onSuccess();
                }
                yield chunk;
            }
            if (!streamStarted) {
                this.onSuccess();
            }
        } catch (error) {
            if (this.isTrippableError(error)) {
                 this.onFailure();
            } else if (!streamStarted) {
                 this.onSuccess(); // It failed cleanly via client validation error
            }
            throw error;
        }
    }

    isTrippableError(error) {
        // Only trip on network failures, timeouts, and 5xx errors
        if (error.code === 'ECONNREFUSED' || error.code === 'FETCH_ERROR') return true;
        if (error.status && error.status >= 500) return true;
        
        // Don't trip for 4xx standard client errors
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) return false;
        
        // Trip for 429s as it indicates overload
        if (error.status === 429) return true;

        if (error.message && (error.message.includes('timeout') || error.message.includes('fetch failed'))) {
            return true;
        }
        return false;
    }

    onSuccess() {
        this.metrics.successfulRequests++;
        if (this.state !== 'CLOSED') {
            this.failures = 0;
            this.state = 'CLOSED';
            this.lastFailureTime = null;
        }
    }

    onFailure() {
        this.metrics.failedRequests++;
        this.failures++;
        this.lastFailureTime = Date.now();
        if (this.state === 'HALF-OPEN' || this.failures >= this.failureThreshold) {
            this.state = 'OPEN';
        }
    }
}
