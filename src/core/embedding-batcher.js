export class EmbeddingBatcher {
    constructor(options = {}) {
        this.maxSize = options.maxSize || 32;
        this.windowMs = options.windowMs || 20;
        this.queues = new Map();
        this.timers = new Map();
    }

    _key(request) {
        return String(request.dimensions ?? '');
    }

    submit(adapter, modelConfig, request) {
        if (Array.isArray(request.input)) {
            return adapter.createEmbedding(modelConfig, request);
        }

        const key = this._key(request);

        return new Promise((resolve, reject) => {
            let queue = this.queues.get(key);
            if (!queue) {
                queue = [];
                this.queues.set(key, queue);
            }

            queue.push({ request, resolve, reject });

            if (queue.length >= this.maxSize) {
                this._flush(key, adapter, modelConfig);
            } else if (!this.timers.has(key)) {
                this.timers.set(key, setTimeout(() => {
                    this.timers.delete(key);
                    this._flush(key, adapter, modelConfig);
                }, this.windowMs));
            }
        });
    }

    _flush(key, adapter, modelConfig) {
        const timer = this.timers.get(key);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.timers.delete(key);
        }

        const queue = this.queues.get(key);
        if (!queue || queue.length === 0) return;
        this.queues.set(key, []);

        if (queue.length === 1) {
            const { request, resolve, reject } = queue[0];
            adapter.createEmbedding(modelConfig, request).then(resolve, reject);
            return;
        }

        const inputs = queue.map(({ request }) =>
            Array.isArray(request.input) ? request.input[0] : request.input
        );

        const merged = { ...queue[0].request, input: inputs };

        adapter.createEmbedding(modelConfig, merged)
            .then(response => {
                const items = response.data || [];
                for (let i = 0; i < queue.length; i++) {
                    queue[i].resolve({
                        ...response,
                        data: [{ ...items[i], index: 0 }],
                        usage: response.usage
                    });
                }
            })
            .catch(error => {
                for (const entry of queue) entry.reject(error);
            });
    }
}
