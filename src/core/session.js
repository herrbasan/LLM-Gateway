import crypto from 'node:crypto';

import { snakeToCamel } from '../utils/format.js';

export class SessionStore {
    constructor(config) {
        this.config = config;
        this.sessions = new Map();
        this.ttlMinutes = config.sessions?.ttlMinutes || 60;
        
        // Start cleanup interval
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
        // Ensure cleanup doesn't block node process exit
        this.cleanupInterval.unref();
    }

    createSession(options = {}) {
        const id = crypto.randomUUID();
        let contextStrategy = {};
        if (options.context_strategy) {
            contextStrategy = snakeToCamel(options.context_strategy);
        }

        const session = {
            id,
            created_at: Date.now(),
            last_accessed: Date.now(),
            ttl_minutes: options.ttl_minutes || this.ttlMinutes,
            context_strategy: {
                mode: contextStrategy.mode || options.strategy || this.config.compaction?.mode || 'truncate',
                preserveSystemPrompt: contextStrategy.preserveSystemPrompt ?? options.preserveSystemPrompt ?? this.config.compaction?.preserveSystemPrompt ?? true,
                ...contextStrategy
            },
            messages: [],
            compression_count: 0
        };
        // Backwards compatibility for internal access to string 'strategy'
        session.strategy = session.context_strategy.mode;

        this.sessions.set(id, session);
        return session;
    }

    getSession(id) {
        const session = this.sessions.get(id);
        if (session) {
            session.last_accessed = Date.now();
        }
        return session;
    }

    updateSession(id, updates) {
        const session = this.getSession(id);
        if (!session) throw new Error("Session not found");
        
        let contextStrategyUpdates = {};
        if (updates.context_strategy) {
            contextStrategyUpdates = snakeToCamel(updates.context_strategy);
        }

        if (updates.strategy || contextStrategyUpdates.mode) {
            session.context_strategy.mode = contextStrategyUpdates.mode || updates.strategy;
            session.strategy = session.context_strategy.mode;
        }
        if (updates.preserveSystemPrompt !== undefined || contextStrategyUpdates.preserveSystemPrompt !== undefined) {
            session.context_strategy.preserveSystemPrompt = contextStrategyUpdates.preserveSystemPrompt ?? updates.preserveSystemPrompt;
        }

        session.context_strategy = {
            ...session.context_strategy,
            ...contextStrategyUpdates
        };
        
        return session;
    }

    appendMessages(id, newMessages) {
        const session = this.getSession(id);
        if (!session) throw new Error("Session not found");
        
        if (newMessages && newMessages.length > 0) {
             session.messages.push(...newMessages);
        }
        return session;
    }
    
    replaceMessages(id, filteredMessages) {
        const session = this.getSession(id);
        if (!session) throw new Error("Session not found");
        
        session.messages = filteredMessages;
        session.compression_count = (session.compression_count || 0) + 1;
        return session;
    }

    deleteSession(id) {
        return this.sessions.delete(id);
    }

    cleanup() {
        const now = Date.now();
        const expiryMs = this.ttlMinutes * 60 * 1000;
        for (const [id, session] of this.sessions.entries()) {
            if (now - session.last_accessed > expiryMs) {
                this.sessions.delete(id);
            }
        }
    }
    
    destroy() {
        clearInterval(this.cleanupInterval);
    }
}
