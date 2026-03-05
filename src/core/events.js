import { EventEmitter } from 'node:events';
export const systemEvents = new EventEmitter();
export const EVENT_TYPES = {
  TASK_CREATED: 'task.created',
  TASK_UPDATED: 'task.updated',
  COMPACTION_STARTED: 'compaction.started',
  COMPACTION_COMPLETED: 'compaction.completed',
  ROUTE_HANDLED: 'route.handled'
};
