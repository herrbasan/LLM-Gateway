// ============================================
// Conversation State Management
// ============================================

export class Conversation {
    constructor(storageKey = 'chat-conversation') {
        this.exchanges = []; // {id, user: {role, content, attachments}, assistant: {role, content, versions: [], currentVersion}}
        this.storageKey = storageKey;
        this.load();
    }

    // Generate unique ID
    _generateId() {
        return 'ex_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // ============================================
    // Exchange Management
    // ============================================

    addExchange(userContent, attachments = []) {
        const exchange = {
            id: this._generateId(),
            timestamp: Date.now(),
            user: {
                role: 'user',
                content: userContent,
                attachments: attachments // Array of {dataUrl, name, type}
            },
            assistant: {
                role: 'assistant',
                content: '',
                versions: [], // Array of alternative responses
                currentVersion: 0,
                isStreaming: true,
                isComplete: false
            }
        };
        
        this.exchanges.push(exchange);
        this.save();
        return exchange.id;
    }

    getExchange(id) {
        return this.exchanges.find(e => e.id === id);
    }

    deleteExchange(id) {
        const index = this.exchanges.findIndex(e => e.id === id);
        if (index !== -1) {
            this.exchanges.splice(index, 1);
            this.save();
        }
    }

    // ============================================
    // Assistant Response Management
    // ============================================

    updateAssistantResponse(exchangeId, delta) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return;
        
        exchange.assistant.content += delta;
        this.save();
    }

    setAssistantComplete(exchangeId) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return;
        
        exchange.assistant.isStreaming = false;
        exchange.assistant.isComplete = true;
        
        // Save this version
        exchange.assistant.versions.push({
            content: exchange.assistant.content,
            timestamp: Date.now()
        });
        
        this.save();
    }

    setAssistantError(exchangeId, error) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return;
        
        exchange.assistant.isStreaming = false;
        exchange.assistant.error = error;
        this.save();
    }

    // ============================================
    // Version Control (Regenerate)
    // ============================================

    regenerateResponse(exchangeId) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return false;
        
        // Save current as version if not already saved
        if (exchange.assistant.content && !exchange.assistant.versions.find(v => v.content === exchange.assistant.content)) {
            exchange.assistant.versions.push({
                content: exchange.assistant.content,
                timestamp: Date.now()
            });
        }
        
        // Reset for new response
        exchange.assistant.content = '';
        exchange.assistant.isStreaming = true;
        exchange.assistant.isComplete = false;
        exchange.assistant.error = null;
        
        this.save();
        return true;
    }

    switchVersion(exchangeId, direction) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange || exchange.assistant.versions.length === 0) return false;
        
        const versions = exchange.assistant.versions;
        let newIndex;
        
        if (direction === 'next') {
            newIndex = (exchange.assistant.currentVersion + 1) % versions.length;
        } else {
            newIndex = (exchange.assistant.currentVersion - 1 + versions.length) % versions.length;
        }
        
        exchange.assistant.currentVersion = newIndex;
        exchange.assistant.content = versions[newIndex].content;
        this.save();
        
        return true;
    }

    getVersionInfo(exchangeId) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return null;
        
        return {
            current: exchange.assistant.currentVersion + 1,
            total: exchange.assistant.versions.length,
            hasMultiple: exchange.assistant.versions.length > 1
        };
    }

    // ============================================
    // API Format
    // ============================================

    getMessagesForApi(systemPrompt = '') {
        const messages = [];
        
        // Add system prompt if provided
        if (systemPrompt?.trim()) {
            messages.push({
                role: 'system',
                content: systemPrompt.trim()
            });
        }
        
        // Add exchanges
        for (const exchange of this.exchanges) {
            // User message
            if (exchange.user.attachments?.length > 0) {
                // Multimodal content
                const content = [
                    ...exchange.user.attachments.map(att => ({
                        type: 'image_url',
                        image_url: { url: att.dataUrl }
                    })),
                    {
                        type: 'text',
                        text: exchange.user.content
                    }
                ];
                messages.push({ role: 'user', content });
            } else {
                messages.push({
                    role: 'user',
                    content: exchange.user.content
                });
            }
            
            // Assistant message (only if complete)
            if (exchange.assistant.isComplete && exchange.assistant.content) {
                messages.push({
                    role: 'assistant',
                    content: exchange.assistant.content
                });
            }
        }
        
        return messages;
    }

    // ============================================
    // Persistence
    // ============================================

    save() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.exchanges));
        } catch (error) {
            console.error('[Conversation] Failed to save:', error);
            // Handle quota exceeded - remove oldest exchanges
            if (error.name === 'QuotaExceededError' && this.exchanges.length > 5) {
                this.exchanges = this.exchanges.slice(-5);
                localStorage.setItem(this.storageKey, JSON.stringify(this.exchanges));
            }
        }
    }

    load() {
        try {
            const data = localStorage.getItem(this.storageKey);
            if (data) {
                this.exchanges = JSON.parse(data);
            }
        } catch (error) {
            console.error('[Conversation] Failed to load:', error);
            this.exchanges = [];
        }
    }

    clear() {
        this.exchanges = [];
        localStorage.removeItem(this.storageKey);
    }

    // ============================================
    // Getters
    // ============================================

    getAll() {
        return this.exchanges;
    }

    getLast() {
        return this.exchanges[this.exchanges.length - 1] || null;
    }

    get length() {
        return this.exchanges.length;
    }
}
