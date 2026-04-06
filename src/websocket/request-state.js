export const RequestState = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed'
};

export class RequestContext {
  constructor(id, params) {
    this.id = id;
    this.params = params;
    this.state = RequestState.PENDING;
    this.startTime = Date.now();
    this.chunksSent = 0;
    this.firstTokenLatencyMs = 0;
    this.totalLatencyMs = 0;
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
    this.finishReason = null;
    this.adapterModel = null;
    this.adapterProvider = null;
    this.hasEmittedReasoning = false;
  }

  transition(newState) {
    const validTransitions = {
      [RequestState.PENDING]: [RequestState.PROCESSING, RequestState.CANCELLED, RequestState.FAILED],
      [RequestState.PROCESSING]: [RequestState.COMPLETED, RequestState.CANCELLED, RequestState.FAILED],
      [RequestState.CANCELLED]: [],
      [RequestState.COMPLETED]: [],
      [RequestState.FAILED]: []
    };

    if (!validTransitions[this.state].includes(newState)) {
      throw new Error(`Invalid state transition from ${this.state} to ${newState}`);
    }

    this.state = newState;

    if (newState === RequestState.PROCESSING) {
      this.firstTokenLatencyMs = Date.now() - this.startTime;
    } else if (newState === RequestState.COMPLETED || newState === RequestState.CANCELLED || newState === RequestState.FAILED) {
      if (this.firstTokenLatencyMs === 0 && newState !== RequestState.PENDING) {
        // Fallback for immediate failures or cancellations
        this.firstTokenLatencyMs = Date.now() - this.startTime;
      }
      this.totalLatencyMs = Date.now() - this.startTime;
    }
  }

  cancel() {
    if (this.state === RequestState.PENDING || this.state === RequestState.PROCESSING) {
      this.abortController.abort();
      this.transition(RequestState.CANCELLED);
      return true;
    }
    return false;
  }
}