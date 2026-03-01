import crypto from 'node:crypto';

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
        const session = {
            id,
            created_at: Date.now(),
            last_accessed: Date.now(),
            strategy: options.strategy || this.config.compaction?.mode || 'truncate',
            preserveSystemPrompt: options.preserveSystemPrompt ?? this.config.compaction?.preserveSystemPrompt ?? true,
            messages: []
        };
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
        
        if (updates.strategy) session.strategy = updates.strategy;
        if (updates.preserveSystemPrompt !== undefined) session.preserveSystemPrompt = updates.preserveSystemPrompt;
        
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
