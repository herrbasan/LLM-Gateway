// src/websocket/metrics.js
export class WebSocketMetrics {
  constructor() {
    this.metrics = {
      ws_connections_active: 0,
      ws_connections_total: 0,
      ws_connections_rejected: 0,
      ws_errors_total: {}, // Map of errorCode -> count
      ws_reconnects_total: 0,
      ws_backpressure_events_total: 0,
      ws_request_cancelled_total: 0,
      ws_request_timeout_total: 0,
      ws_buffer_tokens_current: 0,
      // Store raw samples for histograms
      ws_first_token_latency_ms: [],
      ws_request_duration_ms: [],
    };
  }

  increment(metric, label = null) {
    if (label !== null) {
      if (typeof this.metrics[metric] === 'object') {
        this.metrics[metric][label] = (this.metrics[metric][label] || 0) + 1;
      }
    } else if (typeof this.metrics[metric] === 'number') {
      this.metrics[metric]++;
    }
  }

  decrement(metric) {
    if (typeof this.metrics[metric] === 'number') {
      this.metrics[metric]--;
    }
  }

  set(metric, value) {
    if (typeof this.metrics[metric] === 'number') {
      this.metrics[metric] = value;
    }
  }

  recordFirstTokenLatency(ms) {
    this.metrics.ws_first_token_latency_ms.push(ms);
    // Keep bounded
    if (this.metrics.ws_first_token_latency_ms.length > 1000) {
      this.metrics.ws_first_token_latency_ms.shift();
    }
  }

  recordRequestDuration(ms) {
    this.metrics.ws_request_duration_ms.push(ms);
    // Keep bounded
    if (this.metrics.ws_request_duration_ms.length > 1000) {
      this.metrics.ws_request_duration_ms.shift();
    }
  }

  getMetrics() {
    // Calculate simple stats for histograms
    const agg = (arr) => {
      if (arr.length === 0) return { min: 0, max: 0, avg: 0, count: 0 };
      const sum = arr.reduce((a, b) => a + b, 0);
      return {
        min: Math.min(...arr),
        max: Math.max(...arr),
        avg: Math.round(sum / arr.length),
        count: arr.length
      };
    };

    return {
      ...this.metrics,
      ws_first_token_latency_ms: agg(this.metrics.ws_first_token_latency_ms),
      ws_request_duration_ms: agg(this.metrics.ws_request_duration_ms)
    };
  }
}

export const wsMetrics = new WebSocketMetrics();
