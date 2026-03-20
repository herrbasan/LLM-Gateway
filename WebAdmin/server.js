const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 3401;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const NUI_DIR = path.join(__dirname, 'lib/nui_wc2/NUI');
const EMBEDDED_CHAT_ROOT = path.join(__dirname, 'LLM-Gateway-Chat');
const EMBEDDED_CHAT_DIR = path.join(__dirname, 'LLM-Gateway-Chat', 'chat');
const EMBEDDED_CHAT_SHARED_DIR = path.join(EMBEDDED_CHAT_ROOT, 'shared');
const EMBEDDED_CHAT_INDEX_PATH = path.join(EMBEDDED_CHAT_DIR, 'index.html');
const EMBEDDED_CHAT_CONFIG_PATH = path.join(EMBEDDED_CHAT_DIR, 'js', 'config.js');

function buildEmbeddedChatIndex() {
    return fs.readFileSync(EMBEDDED_CHAT_INDEX_PATH, 'utf8')
        .replaceAll('../shared/', '/shared/')
        .replaceAll('../nui_wc2/NUI/', '/NUI/');
}

function setNoStore(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

function createApp() {
    const app = express();

    app.use(express.json());

    app.use(express.static(PUBLIC_DIR));
    app.use('/NUI', express.static(NUI_DIR));
    app.use('/nui_wc2/NUI', express.static(NUI_DIR));

    if (fs.existsSync(EMBEDDED_CHAT_INDEX_PATH)) {
        if (fs.existsSync(EMBEDDED_CHAT_SHARED_DIR)) {
            app.use('/shared', express.static(EMBEDDED_CHAT_SHARED_DIR));
        }

        if (fs.existsSync(EMBEDDED_CHAT_CONFIG_PATH)) {
            app.get('/chat/js/config.js', (req, res) => {
                setNoStore(res);
                res.type('application/javascript').send(fs.readFileSync(EMBEDDED_CHAT_CONFIG_PATH, 'utf8'));
            });
        }

        app.get(['/chat', '/chat/', '/chat/index.html'], (req, res) => {
            setNoStore(res);
            res.type('html').send(buildEmbeddedChatIndex());
        });

        app.use('/chat', express.static(EMBEDDED_CHAT_DIR, { index: false }));
    }

    app.use('/api', require('./routes/api'));

    app.get(/.*/, (req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });

    app.use((err, req, res, next) => {
        console.error('[WebAdmin] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    });

    return app;
}

if (require.main === module) {
    const app = createApp();

    app.listen(PORT, HOST, () => {
        console.log(`[WebAdmin] Server running on http://${HOST}:${PORT}`);
        console.log(`[WebAdmin] Gateway proxy: ${process.env.GATEWAY_URL || 'http://localhost:3400'}`);
    });
}

module.exports = { createApp };
