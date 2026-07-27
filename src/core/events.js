import { EventEmitter } from 'node:events';
export const systemEvents = new EventEmitter();
export const EVENT_TYPES = {
  TASK_CREATED: 'task.created',
  TASK_UPDATED: 'task.updated'
};
