// One failure is a log line. The same failure repeating is an incident.
//
// On 2026-09-19 the log held seven identical 400s over thirty minutes, and a
// reader could not tell whether that was one stuck chat retrying or seven
// separate breakages. The most useful fact about the incident — that it was one
// cause, one period, and how long it had been going — was invisible, and finding
// it took a manual scan of the whole file.
//
// Every failure line therefore carries its own history: how many times this exact
// failure has occurred so far, when it started, and how many distinct clients it
// has hit. Nothing is suppressed — a log line is evidence — so the count is
// context on the line, not a substitute for it.
//
// Counting identity is type + code + model + adapter + component. Deliberately
// not the message (upstream text varies between retries: retry hints, token
// counts) and not the client (one broken upstream hitting two chats is one
// incident).
//
// State is per-process: a gateway restart resets the counters, which is correct —
// a new process cannot know what happened before it, and pretending otherwise
// would attach another run's history to this one.

import { clientKey } from './client-identity.js';

const WINDOW_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;
const MESSAGE_FINGERPRINT_LENGTH = 60;

const failures = new Map();

function fingerprintOf(message, meta, component) {
    const parts = [
        component || '-',
        meta.type || '-',
        meta.code || '-',
        meta.model || '-',
        meta.adapter || '-'
    ];
    // Without a type or code there is nothing stable to group on, so the head of
    // the message stands in — better a slightly-too-specific group than three
    // unrelated failures merged into one.
    if (!meta.type && !meta.code) {
        parts.push(String(message).slice(0, MESSAGE_FINGERPRINT_LENGTH));
    }
    return parts.join('|');
}

function prune(now) {
    for (const [key, entry] of failures) {
        if (now - entry.firstSeenAt > WINDOW_MS) failures.delete(key);
    }
    while (failures.size > MAX_ENTRIES) {
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [key, entry] of failures) {
            if (entry.firstSeenAt < oldestAt) {
                oldestAt = entry.firstSeenAt;
                oldestKey = key;
            }
        }
        failures.delete(oldestKey);
    }
}

function record(fingerprint, client, now) {
    let entry = failures.get(fingerprint);
    if (!entry || now - entry.firstSeenAt > WINDOW_MS) {
        entry = { count: 0, firstSeenAt: now, clients: new Set() };
        failures.set(fingerprint, entry);
    }
    entry.count++;
    if (client) entry.clients.add(clientKey(client));
    prune(now);
    return entry;
}

/**
 * Log a failure, annotated with how often this same failure has been seen.
 *
 * @param {object} options
 * @param {object} options.logger    the caller's logger instance
 * @param {string} options.component log component, e.g. 'StreamHandler'
 * @param {string} options.message   human-readable description
 * @param {object} [options.meta]    structured fields; `meta.client` (from
 *   describeClient) is used to count distinct clients and is kept on the line
 * @param {'warn'|'error'} [options.level] severity, default 'error'
 */
export function logFailure({ logger, component, message, meta = {}, level = 'error' }) {
    if (!logger || typeof logger.error !== 'function') {
        throw new Error('[failure-log] logFailure requires a logger with .error()');
    }
    if (typeof message !== 'string' || message.length === 0) {
        throw new Error('[failure-log] logFailure requires a message');
    }
    if (level !== 'warn' && level !== 'error') {
        throw new Error(`[failure-log] level must be 'warn' or 'error', got "${level}"`);
    }

    const now = Date.now();
    const fingerprint = fingerprintOf(message, meta, component);
    const entry = record(fingerprint, meta.client || null, now);

    logger[level](message, null, {
        ...meta,
        failure: {
            fingerprint,
            count: entry.count,
            firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
            distinctClients: entry.clients.size
        }
    }, component);

    return { fingerprint, count: entry.count, distinctClients: entry.clients.size };
}

/**
 * Drop all aggregation state. Tests only — a running gateway keeps its history.
 */
export function resetFailureState() {
    failures.clear();
}
