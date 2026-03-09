const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3401;
const HOST = process.env.HOST || '0.0.0.0';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3400';

// Middleware
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/NUI', express.static(path.join(__dirname, 'lib/nui_wc2/NUI')));

// API routes
app.use('/api', require('./routes/api'));

// Chat routes (standalone page, not part of SPA)
app.use('/chat', require('./routes/chat'));
app.use('/chat', express.static(path.join(__dirname, 'public/chat')));
app.use('/shared/vendor', express.static(path.join(__dirname, 'public/shared/vendor')));

// SPA fallback - serve index.html for all non-API, non-chat routes
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
    console.error('[WebAdmin] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
    console.log(`[WebAdmin] Server running on http://${HOST}:${PORT}`);
    console.log(`[WebAdmin] Gateway proxy: ${GATEWAY_URL}`);
});
