import { systemEvents, EVENT_TYPES } from '../core/events.js';

export function createSystemEventsHandler() {
  return (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Ensure the connection doesn't time out
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'System events stream connected', timestamp: Date.now() })}\n\n`);

    const createHandler = (eventType) => {
      return (data) => {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
      };
    };

    const taskCreatedHandler = createHandler(EVENT_TYPES.TASK_CREATED);
    const taskUpdatedHandler = createHandler(EVENT_TYPES.TASK_UPDATED);
    const compactionStartedHandler = createHandler(EVENT_TYPES.COMPACTION_STARTED);
    const compactionCompletedHandler = createHandler(EVENT_TYPES.COMPACTION_COMPLETED);

    systemEvents.on(EVENT_TYPES.TASK_CREATED, taskCreatedHandler);
    systemEvents.on(EVENT_TYPES.TASK_UPDATED, taskUpdatedHandler);
    systemEvents.on(EVENT_TYPES.COMPACTION_STARTED, compactionStartedHandler);
    systemEvents.on(EVENT_TYPES.COMPACTION_COMPLETED, compactionCompletedHandler);

    // Handle client disconnect
    req.on('close', () => {
      systemEvents.off(EVENT_TYPES.TASK_CREATED, taskCreatedHandler);
      systemEvents.off(EVENT_TYPES.TASK_UPDATED, taskUpdatedHandler);
      systemEvents.off(EVENT_TYPES.COMPACTION_STARTED, compactionStartedHandler);
      systemEvents.off(EVENT_TYPES.COMPACTION_COMPLETED, compactionCompletedHandler);
      res.end();
    });
  };
}
