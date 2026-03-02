import crypto from 'node:crypto';

export class TicketRegistry {
    constructor() {
        this.tickets = new Map();
        // Cleanup expired tickets
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [id, ticket] of this.tickets.entries()) {
                // Remove tickets older than 1 hour
                if (now - ticket.created_at > 60 * 60 * 1000) {
                    this.tickets.delete(id);
                }
            }
        }, 60 * 1000);
        this.cleanupInterval.unref();
    }

    createTicket(estimatedChunks = 1) {
        const id = `tkt_${crypto.randomBytes(6).toString('hex')}`;
        const ticket = {
            id,
            status: 'accepted', // accepted, processing, complete, failed
            estimated_chunks: estimatedChunks,
            created_at: Date.now(),
            events: [], // Store events to replay for streaming clients
            result: null, // Final result if non-streaming
            error: null
        };
        this.tickets.set(id, ticket);
        return ticket;
    }

    getTicket(id) {
        return this.tickets.get(id);
    }

    subscribe(id, callback) {
        const ticket = this.getTicket(id);
        if (!ticket) return null;
        if (!ticket.subscribers) ticket.subscribers = new Set();
        ticket.subscribers.add(callback);
        return () => ticket.subscribers.delete(callback);
    }

    updateTicketStatus(id, status, extra = {}) {
        const ticket = this.getTicket(id);
        if (ticket) {
            ticket.status = status;
            Object.assign(ticket, extra);
            if (status === 'complete' || status === 'failed') {
                if (ticket.subscribers) {
                    for (const sub of ticket.subscribers) {
                        sub({ type: 'status_update', status, extra });
                    }
                }
            }
        }
    }

    addEvent(id, event) {
        const ticket = this.getTicket(id);
        if (ticket) {
            ticket.events.push(event);
            if (ticket.subscribers) {
                for (const sub of ticket.subscribers) {
                    sub(event);
                }
            }
        }
    }
}
