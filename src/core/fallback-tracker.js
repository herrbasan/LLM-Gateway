/**
 * FallbackTracker - Tracks task model failures and manages fallback switching.
 *
 * When a primary model fails, the tracker switches to the fallback model
 * for a cooldown period. After cooldown expires, the primary is tried again.
 *
 * Cooldown is per-task, set via task config `fallbackCooldownMs`.
 *
 * State is in-memory only — resets on gateway restart.
 */

import { getLogger } from '../utils/logger.js';

const logger = getLogger();

const DEFAULT_COOLDOWN_MS = 60_000;

export class FallbackTracker {
    constructor() {
        // Map<taskId, { failedAt: number, cooldownMs: number, model: string, error: string }>
        this.failures = new Map();
    }

    /**
     * Record a failure for a task's primary model.
     * Switches subsequent requests to the fallback model for cooldownMs.
     */
    recordFailure(taskId, modelName, cooldownMs, error) {
        const effectiveCooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.failures.set(taskId, {
            failedAt: Date.now(),
            cooldownMs: effectiveCooldown,
            model: modelName,
            error: error.message || String(error)
        });
        logger.warn('Task primary model failed, switching to fallback', {
            task: taskId,
            failedModel: modelName,
            cooldownMs: effectiveCooldown,
            error: error.message || String(error)
        }, 'FallbackTracker');
    }

    /**
     * Record a success.
     * @param {string} taskId
     * @param {boolean} [servedByFallback=false] - true when the FALLBACK model
     *   served the request. A fallback success must NOT clear the failure state:
     *   the primary is still down, and the cooldown must run to expiry before
     *   the primary is retried. Only a PRIMARY success clears state.
     */
    recordSuccess(taskId, servedByFallback = false) {
        if (servedByFallback) {
            // Fallback served — primary still down, keep the failure entry so
            // shouldUseFallback keeps routing to the fallback until cooldown.
            return;
        }
        if (this.failures.has(taskId)) {
            logger.info('Task recovered, clearing fallback state', {
                task: taskId
            }, 'FallbackTracker');
            this.failures.delete(taskId);
        }
    }

    /**
     * Check if a task should use its fallback model.
     * Returns true if the primary failed and cooldown hasn't expired.
     */
    shouldUseFallback(taskId) {
        const failure = this.failures.get(taskId);
        if (!failure) return false;

        const elapsed = Date.now() - failure.failedAt;
        if (elapsed >= failure.cooldownMs) {
            // Cooldown expired — let the primary try again
            this.failures.delete(taskId);
            logger.info('Fallback cooldown expired, retrying primary model', {
                task: taskId,
                failedModel: failure.model
            }, 'FallbackTracker');
            return false;
        }

        return true;
    }

    /**
     * Get the failure state for diagnostics.
     */
    getState() {
        const state = {};
        for (const [taskId, failure] of this.failures.entries()) {
            state[taskId] = {
                ...failure,
                remainingMs: Math.max(0, failure.cooldownMs - (Date.now() - failure.failedAt))
            };
        }
        return state;
    }
}
