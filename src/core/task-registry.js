/**
 * TaskRegistry - Stores and resolves task configurations.
 * Tasks define semantic routing with preset parameters.
 * Client request params always override task defaults.
 */

import { getLogger } from '../utils/logger.js';

const logger = getLogger();

const TASK_CHAT_PARAMS = new Set([
    'model', 'systemPrompt', 'maxTokens', 'temperature', 'topP', 'topK',
    'stripThinking', 'noThinking', 'responseFormat', 'extraBody',
    'presencePenalty', 'frequencyPenalty', 'seed', 'stop',
    'max_tokens', 'strip_thinking', 'no_thinking', 'top_p', 'top_k',
    'presence_penalty', 'frequency_penalty', 'response_format',
    'extra_body', 'enable_thinking', 'chat_template_kwargs'
]);

const PARAM_NORMALIZATION = {
    maxTokens: 'max_tokens',
    max_tokens: 'max_tokens',
    systemPrompt: null,
    stripThinking: 'strip_thinking',
    strip_thinking: 'strip_thinking',
    noThinking: 'no_thinking',
    no_thinking: 'no_thinking',
    topP: 'top_p',
    top_p: 'top_p',
    topK: 'top_k',
    top_k: 'top_k',
    presencePenalty: 'presence_penalty',
    presence_penalty: 'presence_penalty',
    frequencyPenalty: 'frequency_penalty',
    frequency_penalty: 'frequency_penalty',
    responseFormat: 'response_format',
    response_format: 'response_format',
    extraBody: 'extra_body',
    extra_body: 'extra_body'
};

export class TaskRegistry {
    constructor(tasks = {}) {
        this.tasks = new Map();
        for (const [id, config] of Object.entries(tasks)) {
            this.tasks.set(id, Object.freeze({ ...config }));
        }
        logger.info('Initialized', { taskCount: this.tasks.size, tasks: Array.from(this.tasks.keys()) }, 'TaskRegistry');
    }

    has(taskId) {
        return this.tasks.has(taskId);
    }

    get(taskId) {
        return this.tasks.get(taskId) || null;
    }

    getAll() {
        const result = {};
        for (const [id, config] of this.tasks.entries()) {
            result[id] = { ...config };
        }
        return result;
    }

    /**
     * Resolve a task and merge its defaults into the request body.
     * Client params always override task defaults.
     * Returns { resolvedRequest, taskInfo } where taskInfo is null if no task was used.
     */
    resolveChatRequest(request) {
        const taskId = request.task;
        if (!taskId) {
            return { resolvedRequest: request, taskInfo: null };
        }

        const task = this.tasks.get(taskId);
        if (!task) {
            const err = new Error(`[TaskRegistry] Unknown task: "${taskId}"`);
            err.status = 400;
            throw err;
        }

        const taskDefaults = this._extractChatDefaults(task);
        const cleanedRequest = this._stripTaskParams(request);
        // Remove undefined values so they don't overwrite task defaults
        for (const key of Object.keys(cleanedRequest)) {
            if (cleanedRequest[key] === undefined) {
                delete cleanedRequest[key];
            }
        }
        const merged = { ...taskDefaults, ...cleanedRequest };

        if (task.systemPrompt) {
            merged.messages = this._prependSystemPrompt(merged.messages, task.systemPrompt);
        }

        const taskInfo = {
            id: taskId,
            model: task.model,
            description: task.description || null
        };

        return { resolvedRequest: merged, taskInfo };
    }

    /**
     * Resolve a task for non-chat endpoints (embedding, image, audio).
     * Only merges the model field and any applicable params.
     */
    resolveGenericRequest(request) {
        const taskId = request.task;
        if (!taskId) {
            return { resolvedRequest: request, taskInfo: null };
        }

        const task = this.tasks.get(taskId);
        if (!task) {
            const err = new Error(`[TaskRegistry] Unknown task: "${taskId}"`);
            err.status = 400;
            throw err;
        }

        const taskDefaults = this._extractGenericDefaults(task);
        const cleanedRequest = this._stripTaskParams(request);
        for (const key of Object.keys(cleanedRequest)) {
            if (cleanedRequest[key] === undefined) {
                delete cleanedRequest[key];
            }
        }
        const merged = { ...taskDefaults, ...cleanedRequest };

        const taskInfo = {
            id: taskId,
            model: task.model,
            description: task.description || null
        };

        return { resolvedRequest: merged, taskInfo };
    }

    _extractChatDefaults(task) {
        const defaults = {};
        for (const key of TASK_CHAT_PARAMS) {
            if (key in task) {
                const normalizedKey = PARAM_NORMALIZATION[key];
                if (normalizedKey === null) {
                    // Handled separately (e.g., systemPrompt)
                } else if (normalizedKey) {
                    defaults[normalizedKey] = task[key];
                } else {
                    defaults[key] = task[key];
                }
            }
        }
        return defaults;
    }

    _extractGenericDefaults(task) {
        const defaults = {};
        for (const [key, value] of Object.entries(task)) {
            if (key === 'description') continue;
            defaults[key] = value;
        }
        return defaults;
    }

    _stripTaskParams(request) {
        const { task, ...rest } = request;
        return rest;
    }

    _prependSystemPrompt(messages, systemPrompt) {
        const systemMessage = { role: 'system', content: systemPrompt };
        if (!messages || messages.length === 0) {
            return [systemMessage];
        }
        return [systemMessage, ...messages];
    }
}
