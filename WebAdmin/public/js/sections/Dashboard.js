// ============================================
// Dashboard - Live monitoring with polling
// DOM-first: Structure rendered once, only values updated
// ============================================

export class Dashboard {
    constructor(element) {
        this.element = element;
        this.pollInterval = null;
        this.eventSource = null;
        this.providersRendered = false;
        this.providerElements = new Map(); // Cache provider row elements
    }
    
    render() {
        this.element.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-header">
                    <h2>Dashboard</h2>
                    <nui-button data-action="refresh-dashboard">
                        <nui-icon name="sync"></nui-icon>
                        <span>Refresh</span>
                    </nui-button>
                </div>
                
                <div class="stats-grid">
                    <div class="stat-card">
                        <h3>Gateway Status</h3>
                        <div class="stat-value" id="gateway-status">
                            <span class="status-indicator checking">Checking...</span>
                        </div>
                    </div>
                    <div class="stat-card">
                        <h3>Providers</h3>
                        <div class="stat-value" id="provider-count">-</div>
                        <small class="text-dim">configured</small>
                    </div>
                    <div class="stat-card">
                        <h3>Online</h3>
                        <div class="stat-value" id="online-count">-</div>
                        <small class="text-dim">healthy</small>
                    </div>
                    <div class="stat-card">
                        <h3>In-Flight</h3>
                        <div class="stat-value" id="active-count">-</div>
                        <small class="text-dim">proxy requests</small>
                    </div>
                </div>

                <div class="active-requests-section" id="monitor-section">
                    <h3>Realtime Monitor</h3>
                    <div id="monitor-status" class="status-indicator checking">Connecting...</div>
                </div>
                
                <div class="active-requests-section" id="active-requests-section">
                    <h3>Recent Activity</h3>
                    <div id="active-requests-list" class="requests-list">
                        <div class="loading-placeholder">Loading...</div>
                    </div>
                </div>
                
                <div class="providers-section">
                    <h3>Provider Status</h3>
                    <div id="providers-list" class="providers-list">
                        <div class="loading-placeholder">Loading providers...</div>
                    </div>
                </div>

                <div class="providers-section">
                    <h3>Recent Gateway Activity</h3>
                    <div id="activity-list" class="requests-list">
                        <div class="loading-placeholder">Waiting for events...</div>
                    </div>
                </div>
            </div>
        `;
        
        // Bind refresh button
        this.element.querySelector('[data-action="refresh-dashboard"]')?.addEventListener('click', () => {
            this.fetchData();
        });
    }
    
    start() {
        this.fetchData();
        this.connectMonitorStream();
        this.pollInterval = setInterval(() => this.fetchData(), 5000);
    }
    
    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }
    
    async fetchData() {
        try {
            const response = await fetch('/api/monitor/state');
            const snapshot = await response.json();
            this.applyMonitorSnapshot(snapshot);
        } catch (error) {
            console.error('[Dashboard] Failed to fetch health:', error);
            this.showOffline();
        }
    }

    connectMonitorStream() {
        if (typeof EventSource === 'undefined') {
            this.updateMonitorStatus('offline', 'SSE not supported');
            return;
        }

        if (this.eventSource) {
            this.eventSource.close();
        }

        this.eventSource = new EventSource('/api/monitor/stream');
        this.updateMonitorStatus('checking', 'Connecting...');

        this.eventSource.addEventListener('connected', () => {
            this.updateMonitorStatus('online', 'Live');
        });

        this.eventSource.addEventListener('state', (evt) => {
            try {
                const snapshot = JSON.parse(evt.data);
                this.applyMonitorSnapshot(snapshot);
            } catch {
                // ignore malformed payload
            }
        });

        this.eventSource.addEventListener('health', (evt) => {
            try {
                const payload = JSON.parse(evt.data);
                this.updateStatus(payload.gateway || {});
                this.updateProviders(payload.gateway?.providers || {});
                this.updateStat('active-count', payload.webadmin?.in_flight ?? '-');
            } catch {
                // ignore malformed payload
            }
        });

        this.eventSource.addEventListener('activity', (evt) => {
            try {
                const event = JSON.parse(evt.data);
                this.prependActivityEvent(event);
            } catch {
                // ignore malformed payload
            }
        });

        this.eventSource.onerror = () => {
            this.updateMonitorStatus('offline', 'Disconnected (retrying)');
        };
    }

    updateMonitorStatus(state, text) {
        const el = this.element.querySelector('#monitor-status');
        if (!el) return;
        el.className = `status-indicator ${state}`;
        el.textContent = text;
    }

    applyMonitorSnapshot(snapshot) {
        this.updateStatus(snapshot.gateway || {});
        this.updateProviders(snapshot.gateway?.providers || {});
        this.updateStat('active-count', snapshot.webadmin?.in_flight ?? '-');
        this.renderActivity(snapshot.recentEvents || []);
    }
    
    updateStatus(data) {
        const statusEl = this.element.querySelector('#gateway-status');
        const isOnline = data.status === 'ok';
        
        if (statusEl) {
            statusEl.innerHTML = isOnline
                ? '<span class="status-indicator online">Online</span>'
                : '<span class="status-indicator offline">Offline</span>';
        }
        
        // Update provider counts
        const providers = data.providers || {};
        const providerNames = Object.keys(providers);
        const onlineCount = providerNames.filter(name => {
            const p = providers[name];
            return p.state === 'CLOSED' || p.state === 'UNKNOWN';
        }).length;
        
        this.updateStat('provider-count', providerNames.length);
        this.updateStat('online-count', onlineCount);
    }
    
    // Render provider table once, then only update values
    updateProviders(providers) {
        const container = this.element.querySelector('#providers-list');
        if (!container) return;
        
        const providerNames = Object.keys(providers);
        
        if (providerNames.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No providers configured</p>
                </div>
            `;
            this.providersRendered = false;
            return;
        }
        
        // First render: Create the table structure
        if (!this.providersRendered) {
            container.innerHTML = `
                <nui-table>
                    <table>
                        <thead>
                            <tr>
                                <th>Provider</th>
                                <th>State</th>
                                <th>Failures</th>
                                <th>Success Rate</th>
                            </tr>
                        </thead>
                        <tbody id="providers-tbody">
                            ${providerNames.map(name => `
                                <tr data-provider="${name}">
                                    <td class="provider-name"><strong>${name}</strong></td>
                                    <td class="provider-state">
                                        <span class="status-badge">-</span>
                                    </td>
                                    <td class="provider-failures">-</td>
                                    <td class="provider-success">-</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </nui-table>
            `;
            
            // Cache row elements for fast updates
            const tbody = container.querySelector('#providers-tbody');
            if (tbody) {
                providerNames.forEach(name => {
                    const row = tbody.querySelector(`tr[data-provider="${name}"]`);
                    if (row) {
                        this.providerElements.set(name, {
                            state: row.querySelector('.provider-state .status-badge'),
                            failures: row.querySelector('.provider-failures'),
                            success: row.querySelector('.provider-success')
                        });
                    }
                });
            }
            
            this.providersRendered = true;
        }
        
        // Update values only (no re-rendering)
        providerNames.forEach(name => {
            const p = providers[name];
            const els = this.providerElements.get(name);
            
            if (els) {
                const isHealthy = p.state === 'CLOSED' || p.state === 'UNKNOWN';
                const isOpen = p.state === 'OPEN';
                
                // Update state badge
                els.state.textContent = p.state || 'UNKNOWN';
                els.state.className = `status-badge ${isHealthy ? 'healthy' : isOpen ? 'error' : 'warning'}`;
                
                // Update failures
                els.failures.textContent = p.failures !== undefined ? p.failures : '-';
                
                // Update success rate
                els.success.textContent = p.successRate !== undefined ? (p.successRate * 100).toFixed(1) + '%' : '-';
            }
        });
    }
    
    updateStat(id, value) {
        const el = this.element.querySelector(`#${id}`);
        if (el) el.textContent = value;
    }
    
    renderEventRow(e) {
        if (e.type === 'gateway_event') {
            const idInfo = e.payload?.sessionId || e.payload?.ticketId || e.payload?.id || '';
            const statusInfo = e.payload?.status || '';
            let details = idInfo;
            if (statusInfo) details += (details ? ` (${statusInfo})` : statusInfo);
            return `
                <tr>
                    <td>${new Date(e.ts).toLocaleTimeString()}</td>
                    <td>EVENT</td>
                    <td><code>${e.event || '-'}</code></td>
                    <td>${details || '-'}</td>
                    <td>-</td>
                </tr>
            `;
        }
        
        return `
            <tr>
                <td>${new Date(e.ts).toLocaleTimeString()}</td>
                <td>${e.method || '-'}</td>
                <td><code>${e.endpoint || '-'}</code></td>
                <td>${e.status ?? '-'}</td>
                <td>${e.latency_ms !== undefined ? `${e.latency_ms}ms` : '-'}</td>
            </tr>
        `;
    }

    updateActiveRequests(events) {
        const section = this.element.querySelector('#active-requests-section');
        const container = this.element.querySelector('#active-requests-list');
        if (!container) return;

        section.hidden = false;

        if (!events || events.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No recent activity</p>
                    <small>Activity appears when requests flow through WebAdmin proxy routes</small>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <nui-table>
                <table>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Method/Type</th>
                            <th>Endpoint/Event</th>
                            <th>Status/Details</th>
                            <th>Latency</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${events.slice(0, 10).map(e => this.renderEventRow(e)).join('')}
                    </tbody>
                </table>
            </nui-table>
        `;
    }

    renderActivity(events) {
        this.updateActiveRequests(events);
    }

    prependActivityEvent(event) {
        const rows = Array.from(this.element.querySelectorAll('#active-requests-list tbody tr'));
        const container = this.element.querySelector('#active-requests-list');

        if (!container) return;

        if (!container.querySelector('table')) {
            this.renderActivity([event]);
            return;
        }

        const tbody = container.querySelector('tbody');
        if (!tbody) return;

        const row = document.createElement('tr');
        row.innerHTML = this.renderEventRow(event).replace(/<tr>|<\/tr>/g, '').trim();

        tbody.prepend(row);
        while (tbody.children.length > 10) {
            tbody.removeChild(tbody.lastChild);
        }
    }
    
    formatAge(timestamp) {
        if (!timestamp) return '-';
        const age = Date.now() - new Date(timestamp).getTime();
        const seconds = Math.floor(age / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h`;
    }
    
    showOffline() {
        const statusEl = this.element.querySelector('#gateway-status');
        if (statusEl) {
            statusEl.innerHTML = '<span class="status-indicator offline">Offline</span>';
        }

        this.updateMonitorStatus('offline', 'Disconnected');
        
        // Reset active count
        this.updateStat('active-count', '-');
        
        // Hide active requests section
        const activeSection = this.element.querySelector('#active-requests-section');
        if (activeSection) activeSection.hidden = true;
        
        // Don't clear the table, just show it's stale
        const container = this.element.querySelector('#providers-list');
        if (container && !this.providersRendered) {
            container.innerHTML = `
                <div class="error-message">
                    <nui-icon name="warning"></nui-icon>
                    Failed to connect to gateway
                </div>
            `;
        }
    }
}
