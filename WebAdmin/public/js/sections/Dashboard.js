// ============================================
// Dashboard - Live monitoring with polling
// DOM-first: Structure rendered once, only values updated
// ============================================

export class Dashboard {
    constructor(element) {
        this.element = element;
        this.pollInterval = null;
        this.eventSource = null;
        this.modelsRendered = false;
        this.modelElements = new Map(); // Cache model row elements
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
                        <h3>Models</h3>
                        <div class="stat-value" id="model-count">-</div>
                        <small class="text-dim">configured</small>
                    </div>
                    <div class="stat-card">
                        <h3>Adapters</h3>
                        <div class="stat-value" id="adapter-count">-</div>
                        <small class="text-dim">available</small>
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
                
                <div class="models-section">
                    <h3>Model Status</h3>
                    <div id="models-list" class="models-list">
                        <div class="loading-placeholder">Loading models...</div>
                    </div>
                </div>

                <div class="models-section">
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
                this.updateModels(payload.gateway?.models || []);
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
        this.updateModels(snapshot.gateway?.models || []);
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
        
        // Update model count
        const models = data.models || [];
        this.updateStat('model-count', models.length);
        
        // Update adapter count from adapters object
        const adapters = data.adapters || {};
        this.updateStat('adapter-count', Object.keys(adapters).length);
    }
    
    // Render model table once, then only update values
    updateModels(models) {
        const container = this.element.querySelector('#models-list');
        if (!container) return;
        
        if (!Array.isArray(models) || models.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No models configured</p>
                </div>
            `;
            this.modelsRendered = false;
            return;
        }
        
        // First render: Create the table structure
        if (!this.modelsRendered) {
            container.innerHTML = `
                <nui-table>
                    <table>
                        <thead>
                            <tr>
                                <th>Model</th>
                                <th>Type</th>
                                <th>Adapter</th>
                                <th>Capabilities</th>
                            </tr>
                        </thead>
                        <tbody id="models-tbody">
                            ${models.map(model => `
                                <tr data-model="${model.id || model}">
                                    <td class="model-name"><strong>${model.id || model}</strong></td>
                                    <td class="model-type">-</td>
                                    <td class="model-adapter">-</td>
                                    <td class="model-caps">-</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </nui-table>
            `;
            
            // Cache row elements for fast updates
            const tbody = container.querySelector('#models-tbody');
            if (tbody) {
                models.forEach(model => {
                    const id = model.id || model;
                    const row = tbody.querySelector(`tr[data-model="${id}"]`);
                    if (row) {
                        this.modelElements.set(id, {
                            type: row.querySelector('.model-type'),
                            adapter: row.querySelector('.model-adapter'),
                            caps: row.querySelector('.model-caps')
                        });
                    }
                });
            }
            
            this.modelsRendered = true;
        }
        
        // Update values only (no re-rendering)
        // Note: Full model details come from /v1/models, health only returns IDs
        // So we just show the model ID list here
    }
    
    updateStat(id, value) {
        const el = this.element.querySelector(`#${id}`);
        if (el) el.textContent = value;
    }
    
    renderEventRow(e) {
        if (e.type === 'gateway_event') {
            const idInfo = e.payload?.ticketId || e.payload?.id || '';
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
        const container = this.element.querySelector('#models-list');
        if (container && !this.modelsRendered) {
            container.innerHTML = `
                <div class="error-message">
                    <nui-icon name="warning"></nui-icon>
                    Failed to connect to gateway
                </div>
            `;
        }
    }
}
