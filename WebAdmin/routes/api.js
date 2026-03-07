const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3400';
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');
const MONITOR_MAX_EVENTS = 100;

const monitorState = {
    startedAt: Date.now(),
    inFlight: 0,
    recentEvents: [],
    lastHealth: null,
    lastHealthAt: null,
    clients: new Set()
};

function writeSse(res, event, data) {
    try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
    } catch {
        return false;
    }
}

function pushMonitorEvent(event) {
    const normalized = {
        id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        ts: Date.now(),
        ...event
    };

    monitorState.recentEvents.unshift(normalized);
    if (monitorState.recentEvents.length > MONITOR_MAX_EVENTS) {
        monitorState.recentEvents.length = MONITOR_MAX_EVENTS;
    }

    for (const client of [...monitorState.clients]) {
        const ok = writeSse(client, 'activity', normalized);
        if (!ok) {
            monitorState.clients.delete(client);
        }
    }
}

async function fetchGatewayHealthSnapshot() {
    try {
        const response = await fetch(`${GATEWAY_URL}/health`, {
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();
        monitorState.lastHealth = data;
        monitorState.lastHealthAt = Date.now();
        return data;
    } catch (error) {
        const fallback = { status: 'unavailable', error: error.message };
        monitorState.lastHealth = fallback;
        monitorState.lastHealthAt = Date.now();
        return fallback;
    }
}

function getMonitorSnapshot() {
    return {
        gateway: monitorState.lastHealth || { status: 'unknown' },
        webadmin: {
            status: 'online',
            gatewayUrl: GATEWAY_URL,
            uptime_ms: Date.now() - monitorState.startedAt,
            in_flight: monitorState.inFlight,
            connected_clients: monitorState.clients.size,
            last_health_at: monitorState.lastHealthAt
        },
        recentEvents: monitorState.recentEvents.slice(0, 25)
    };
}

// ============================================
// Gateway Proxy Helper
// ============================================

async function gatewayFetch(endpoint, options = {}) {
    const url = `${GATEWAY_URL}${endpoint}`;
    const method = options.method || 'GET';
    const startedAt = Date.now();
    monitorState.inFlight += 1;
    console.log(`[WebAdmin Proxy] ${options.method || 'GET'} ${url}`);
    
    try {
        const response = await fetch(url, { ...options,
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
        const latencyMs = Date.now() - startedAt;
        pushMonitorEvent({
            type: 'proxy',
            method,
            endpoint,
            status: response.status,
            latency_ms: latencyMs
        });
        console.log(`[WebAdmin Proxy] Response: ${response.status}`);
        return response;
    } catch (error) {
        const latencyMs = Date.now() - startedAt;
        pushMonitorEvent({
            type: 'proxy_error',
            method,
            endpoint,
            status: 'error',
            latency_ms: latencyMs,
            error: error.message
        });
        console.error(`[WebAdmin Proxy] Error connecting to ${url}:`, error.message);
        throw error;
    } finally {
        monitorState.inFlight = Math.max(0, monitorState.inFlight - 1);
    }
}

// ============================================
// Health & Status
// ============================================

// GET /api/health - Gateway health status
router.get('/health', async (req, res) => {
    try {
        const response = await gatewayFetch('/health');
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(503).json({ 
            status: 'unavailable', 
            error: error.message 
        });
    }
});

// GET /api/status - Combined status (health + tasks summary)
router.get('/status', async (req, res) => {
    try {
        const [healthRes] = await Promise.all([
            gatewayFetch('/health').catch(() => null)
        ]);
        
        const health = healthRes ? await healthRes.json() : { status: 'unknown' };
        
        res.json({
            gateway: health,
            webadmin: {
                status: 'online',
                gatewayUrl: GATEWAY_URL
            }
        });
    } catch (error) {
        res.status(503).json({ 
            error: 'Failed to fetch status',
            message: error.message 
        });
    }
});

// GET /api/monitor/state - Current realtime monitor snapshot
router.get('/monitor/state', async (req, res) => {
    await fetchGatewayHealthSnapshot();
    res.json(getMonitorSnapshot());
});

// GET /api/monitor/stream - Realtime monitor stream (SSE)
router.get('/monitor/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    monitorState.clients.add(res);
    writeSse(res, 'connected', {
        ts: Date.now(),
        connected_clients: monitorState.clients.size
    });

    await fetchGatewayHealthSnapshot();
    writeSse(res, 'state', getMonitorSnapshot());

    const interval = setInterval(async () => {
        const health = await fetchGatewayHealthSnapshot();
        const payload = {
            ts: Date.now(),
            gateway: health,
            webadmin: {
                in_flight: monitorState.inFlight,
                connected_clients: monitorState.clients.size,
                uptime_ms: Date.now() - monitorState.startedAt
            }
        };
        const ok = writeSse(res, 'health', payload);
        if (!ok) {
            clearInterval(interval);
            monitorState.clients.delete(res);
        }
    }, 2000);
    interval.unref?.();

    req.on('close', () => {
        clearInterval(interval);
        monitorState.clients.delete(res);
    });
});

// ============================================
// Internal Gateway SSE Listener
// ============================================

async function setupGatewayEventsListener() {
    let retryTimeout = null;

    const connect = async () => {
        try {
            console.log('[WebAdmin] Connecting to Gateway /v1/system/events...');
            const response = await fetch(`${GATEWAY_URL}/v1/system/events`, {
                headers: { 'Accept': 'text/event-stream' }
            });

            if (!response.ok) {
                throw new Error(`Failed to connect: ${response.status}`);
            }

            console.log('[WebAdmin] Connected to Gateway events stream');
            
            let buffer = '';
            
            const decoder = new TextDecoder("utf-8");
            for await (const chunk of response.body) {
                buffer += decoder.decode(chunk, { stream: true });
                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    const message = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    
                    const lines = message.split('\n');
                    let eventType = 'message';
                    let eventData = null;
                    
                    for (const line of lines) {
                        if (line.startsWith('event: ')) {
                            eventType = line.slice(7);
                        } else if (line.startsWith('data: ')) {
                            try {
                                eventData = JSON.parse(line.slice(6));
                            } catch(e) {
                                eventData = line.slice(6);
                            }
                        }
                    }
                    
                    if (eventData && eventType !== 'connected') {
                        // Push into Monitor feed!
                        pushMonitorEvent({
                            type: 'gateway_event',
                            event: eventType,
                            payload: eventData
                        });
                    }
                    
                    boundary = buffer.indexOf('\n\n');
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('[WebAdmin] Gateway SSE connection drop:', error.message);
            }
        } finally {
            console.log('[WebAdmin] Gateway connection closed. Reconnecting in 5s...');
            clearTimeout(retryTimeout);
            retryTimeout = setTimeout(connect, 5000);
        }
    };

    connect();
}

// Start listener
setupGatewayEventsListener();

// ============================================
// Models
// ============================================

// GET /api/models - Available models
router.get('/models', async (req, res) => {
    try {
        const response = await gatewayFetch('/v1/models');
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(503).json({ 
            error: 'Failed to fetch models',
            message: error.message 
        });
    }
});

// ============================================
// Chat & Embeddings Proxy
// ============================================

// POST /api/proxy/chat/completions
router.post('/proxy/chat/completions', async (req, res) => {
    try {
        console.log('[WebAdmin Proxy] Chat request:', { model: req.body.model });
        
        const response = await gatewayFetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        
        // Forward streaming responses
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            
            console.log('[WebAdmin Proxy] Streaming response...');
            const reader = response.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                }
                res.end();
                console.log('[WebAdmin Proxy] Stream complete');
            } catch (streamError) {
                console.error('[WebAdmin Proxy] Stream error:', streamError.message);
                res.end();
            }
        } else {
            const data = await response.json();
            res.status(response.status).json(data);
        }
    } catch (error) {
        console.error('[WebAdmin Proxy] Chat error:', error.message);
        res.status(502).json({ 
            error: 'Gateway proxy failed',
            message: error.message 
        });
    }
});

// POST /api/proxy/embeddings
router.post('/proxy/embeddings', async (req, res) => {
    try {
        const response = await gatewayFetch('/v1/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(502).json({ 
            error: 'Gateway proxy failed',
            message: error.message 
        });
    }
});

// POST /api/proxy/images/generations
router.post('/proxy/images/generations', async (req, res) => {
    try {
        const response = await gatewayFetch('/v1/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(502).json({
            error: 'Gateway proxy failed',
            message: error.message
        });
    }
});

// POST /api/proxy/audio/speech
router.post('/proxy/audio/speech', async (req, res) => {
    try {
        const response = await gatewayFetch('/v1/audio/speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });

        const contentType = response.headers.get('content-type') || 'application/octet-stream';

        if (!response.ok) {
            if (contentType.includes('application/json')) {
                const errJson = await response.json();
                return res.status(response.status).json(errJson);
            }
            const errText = await response.text();
            return res.status(response.status).send(errText || 'Upstream audio request failed');
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        res.setHeader('Content-Type', contentType);
        res.status(response.status).send(audioBuffer);
    } catch (error) {
        res.status(502).json({
            error: 'Gateway proxy failed',
            message: error.message
        });
    }
});

// GET /api/proxy/media/:filename
router.get('/proxy/media/:filename', async (req, res) => {
    try {
        const response = await gatewayFetch(`/v1/media/${encodeURIComponent(req.params.filename)}`);
        const contentType = response.headers.get('content-type') || 'application/octet-stream';

        if (!response.ok) {
            if (contentType.includes('application/json')) {
                const errJson = await response.json();
                return res.status(response.status).json(errJson);
            }
            const errText = await response.text();
            return res.status(response.status).send(errText || 'Media fetch failed');
        }

        const fileBuffer = Buffer.from(await response.arrayBuffer());
        res.setHeader('Content-Type', contentType);
        res.status(response.status).send(fileBuffer);
    } catch (error) {
        res.status(502).json({
            error: 'Gateway proxy failed',
            message: error.message
        });
    }
});

// ============================================
// Tasks
// ============================================

// GET /api/tasks/:id - Get task status
router.get('/tasks/:id', async (req, res) => {
    try {
        const response = await gatewayFetch(`/v1/tasks/${req.params.id}`);
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(502).json({ 
            error: 'Failed to fetch task',
            message: error.message 
        });
    }
});

// GET /api/tasks/:id/stream - Stream task updates
router.get('/tasks/:id/stream', async (req, res) => {
    try {
        const response = await gatewayFetch(`/v1/tasks/${req.params.id}/stream`);
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
        res.end();
    } catch (error) {
        res.status(502).json({ 
            error: 'Failed to stream task',
            message: error.message 
        });
    }
});

// ============================================
// Model Management (from config.json)
// ============================================

// GET /api/config/models - Get all models from config
router.get('/config/models', async (req, res) => {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(data);
        res.json({ 
            models: config.models || {},
            routing: config.routing || {}
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to read models config',
            message: error.message 
        });
    }
});

// POST /api/config/models - Create a new model
router.post('/config/models', async (req, res) => {
    try {
        const { modelId, modelConfig } = req.body;
        
        if (!modelId || !modelConfig) {
            return res.status(400).json({ error: 'modelId and modelConfig required' });
        }
        
        // Validate model config structure
        if (!modelConfig.type || !modelConfig.adapter) {
            return res.status(400).json({ error: 'modelConfig must have type and adapter' });
        }
        
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(data);
        
        // Check if model already exists
        if (config.models && config.models[modelId]) {
            return res.status(409).json({ error: `Model '${modelId}' already exists` });
        }
        
        // Initialize models if not exists
        if (!config.models) {
            config.models = {};
        }
        
        // Add new model
        config.models[modelId] = modelConfig;
        
        // Create backup
        const backupPath = `${CONFIG_PATH}.backup-${Date.now()}`;
        try {
            await fs.writeFile(backupPath, data);
        } catch {
            // Ignore backup failure
        }
        
        // Save config
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
        
        res.json({ 
            success: true,
            modelId,
            modelConfig
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to create model',
            message: error.message 
        });
    }
});

// PUT /api/config/models/:id - Update a model
router.put('/config/models/:id', async (req, res) => {
    try {
        const modelId = req.params.id;
        const { modelConfig } = req.body;
        
        if (!modelConfig) {
            return res.status(400).json({ error: 'modelConfig required' });
        }
        
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(data);
        
        // Check if model exists
        if (!config.models || !config.models[modelId]) {
            return res.status(404).json({ error: `Model '${modelId}' not found` });
        }
        
        // Create backup
        const backupPath = `${CONFIG_PATH}.backup-${Date.now()}`;
        try {
            await fs.writeFile(backupPath, data);
        } catch {
            // Ignore backup failure
        }
        
        // Update model
        config.models[modelId] = modelConfig;
        
        // Save config
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
        
        res.json({ 
            success: true,
            modelId,
            modelConfig
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to update model',
            message: error.message 
        });
    }
});

// DELETE /api/config/models/:id - Delete a model
router.delete('/config/models/:id', async (req, res) => {
    try {
        const modelId = req.params.id;
        
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(data);
        
        // Check if model exists
        if (!config.models || !config.models[modelId]) {
            return res.status(404).json({ error: `Model '${modelId}' not found` });
        }
        
        // Create backup
        const backupPath = `${CONFIG_PATH}.backup-${Date.now()}`;
        try {
            await fs.writeFile(backupPath, data);
        } catch {
            // Ignore backup failure
        }
        
        // Delete model
        delete config.models[modelId];
        
        // Save config
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
        
        res.json({ 
            success: true,
            modelId
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to delete model',
            message: error.message 
        });
    }
});

// ============================================
// Configuration
// ============================================

// GET /api/config - Current gateway config
router.get('/config', async (req, res) => {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to read config',
            message: error.message 
        });
    }
});

// POST /api/config - Update gateway config
router.post('/config', async (req, res) => {
    try {
        // Validate JSON structure
        const config = req.body;
        if (!config || typeof config !== 'object') {
            return res.status(400).json({ error: 'Invalid JSON: Expected object' });
        }

        // Basic structure validation
        if (config.port !== undefined && typeof config.port !== 'number') {
            return res.status(400).json({ error: 'Invalid port: Expected number' });
        }

        if (config.models !== undefined && typeof config.models !== 'object') {
            return res.status(400).json({ error: 'Invalid models: Expected object' });
        }

        // Create backup before saving
        const backupPath = `${CONFIG_PATH}.backup-${Date.now()}`;
        try {
            const current = await fs.readFile(CONFIG_PATH, 'utf-8');
            await fs.writeFile(backupPath, current);
        } catch {
            // No existing config to backup
        }

        // Write new config
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
        
        res.json({ 
            success: true,
            backupCreated: backupPath 
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to save config',
            message: error.message 
        });
    }
});

// GET /api/config/backups - List available backups
router.get('/config/backups', async (req, res) => {
    try {
        const configDir = path.dirname(CONFIG_PATH);
        const files = await fs.readdir(configDir);
        const backups = files
            .filter(f => f.startsWith('config.json.backup-'))
            .map(f => ({
                filename: f,
                timestamp: parseInt(f.replace('config.json.backup-', '')),
                path: path.join(configDir, f)
            }))
            .sort((a, b) => b.timestamp - a.timestamp);
        
        res.json({ backups });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to list backups',
            message: error.message 
        });
    }
});

// POST /api/config/restore - Restore from backup
router.post('/config/restore', async (req, res) => {
    try {
        const { backupFilename } = req.body;
        if (!backupFilename) {
            return res.status(400).json({ error: 'backupFilename required' });
        }
        
        const backupPath = path.join(path.dirname(CONFIG_PATH), backupFilename);
        const backupData = await fs.readFile(backupPath, 'utf-8');
        
        // Validate it's valid JSON before restoring
        JSON.parse(backupData);
        
        await fs.writeFile(CONFIG_PATH, backupData);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to restore config',
            message: error.message 
        });
    }
});

// ============================================
// Logs
// ============================================

// GET /api/logs - Recent errors/warnings (placeholder)
router.get('/logs', async (req, res) => {
    // TODO: Implement log aggregation from gateway
    res.json({ 
        logs: [],
        note: 'Log aggregation not yet implemented'
    });
});

module.exports = router;
