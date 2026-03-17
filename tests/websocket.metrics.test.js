import { expect } from 'chai';
import { WebSocketMetrics } from '../src/websocket/metrics.js';

describe('WebSocket Metrics', () => {
  let metrics;

  beforeEach(() => {
    metrics = new WebSocketMetrics();
  });

  it('should initialize with correct default values', () => {
    const data = metrics.getMetrics();
    expect(data.ws_connections_active).to.equal(0);
    expect(data.ws_connections_total).to.equal(0);
  });

  it('should increment scalar metrics', () => {
    metrics.increment('ws_connections_total');
    metrics.increment('ws_connections_total');
    expect(metrics.getMetrics().ws_connections_total).to.equal(2);
  });

  it('should track errors by label', () => {
    metrics.increment('ws_errors_total', -32600);
    metrics.increment('ws_errors_total', -32602);
    metrics.increment('ws_errors_total', -32600);

    expect(metrics.getMetrics().ws_errors_total).to.deep.equal({
      '-32600': 2,
      '-32602': 1
    });
  });

  it('should calculate histogram averages', () => {
    metrics.recordFirstTokenLatency(100);
    metrics.recordFirstTokenLatency(200);
    metrics.recordFirstTokenLatency(300);

    const data = metrics.getMetrics();
    expect(data.ws_first_token_latency_ms.min).to.equal(100);
    expect(data.ws_first_token_latency_ms.max).to.equal(300);
    expect(data.ws_first_token_latency_ms.avg).to.equal(200);
    expect(data.ws_first_token_latency_ms.count).to.equal(3);
  });
});
