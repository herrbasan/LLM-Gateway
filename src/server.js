import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHealthHandler } from './routes/health.js';
import { createChatHandler } from './routes/chat.js';
import { createEmbeddingsHandler } from './routes/embeddings.js';
import { createModelsHandler } from './routes/models.js';
import { createTasksHandler, createTasksStreamHandler } from './routes/tasks.js';
import { createImagesHandler } from './routes/images.js';
import { createAudioSpeechHandler } from './routes/audio.js';
import { createVideosHandler } from './routes/videos.js';
import { createSystemEventsHandler } from './routes/events.js';
import { createConfigGetHandler, createConfigStoreHandler } from './routes/config.js';
import { createLogsHandler } from './routes/logs.js';
import { ModelRouter } from './core/model-router.js';
import { TicketRegistry } from './core/ticket-registry.js';
import { getLogger } from './utils/logger.js';
import { sanitizeForLogging } from './utils/safe-logger.js';

const logger = getLogger();

export function createServer(config) {
  const app = express();
  const ticketRegistry = new TicketRegistry();

  // Create new ModelRouter - stateless, no session store needed
  const router = new ModelRouter(config);

  app.locals.router = router;
  app.locals.ticketRegistry = ticketRegistry;

  // CORS middleware
  const corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : true;
  app.use(cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-Async']
  }));

  // Basic middleware
  app.use(express.json({ limit: '10mb' }));

  // Help endpoint
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  
  app.get('/help', (req, res) => {
    try {
      const docsPath = join(__dirname, '..', 'docs', 'api_rest.md');
      const content = readFileSync(docsPath, 'utf-8');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LLM Gateway API Documentation</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
    h2 { color: #34495e; margin-top: 30px; border-bottom: 1px solid #ecf0f1; padding-bottom: 8px; }
    h3 { color: #7f8c8d; }
    code {
      background: #f8f9fa;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 0.9em;
      color: #e74c3c;
    }
    pre {
      background: #2d2d2d;
      color: #f8f8f2;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      line-height: 1.4;
    }
    pre code {
      background: transparent;
      color: inherit;
      padding: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 12px;
      text-align: left;
    }
    th {
      background: #3498db;
      color: white;
    }
    tr:nth-child(even) { background: #f8f9fa; }
    blockquote {
      border-left: 4px solid #3498db;
      margin: 20px 0;
      padding: 10px 20px;
      background: #ecf0f1;
      color: #555;
    }
    hr { border: none; border-top: 1px solid #ecf0f1; margin: 30px 0; }
    a { color: #3498db; text-decoration: none; }
    a:hover { text-decoration: underline; }
    ul, ol { padding-left: 25px; }
  </style>
</head>
<body>
  <div class="container">
    <pre style="background: transparent; color: #333; white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.8;">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
  </div>
</body>
</html>`;
      
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      res.status(500).json({ error: 'Documentation not available' });
    }
  });

  // Basic health endpoint
  app.get('/health', createHealthHandler(config, router));

  // Chat completions endpoint
  app.post('/v1/chat/completions', createChatHandler(router, ticketRegistry));

  // Embeddings endpoint
  app.post('/v1/embeddings', createEmbeddingsHandler(router));

  // Models endpoint
  app.get('/v1/models', createModelsHandler(router));

  // Tasks endpoints (kept for async operations)
  app.get('/v1/tasks/:id', createTasksHandler(ticketRegistry));
  app.get('/v1/tasks/:id/stream', createTasksStreamHandler(ticketRegistry));

  // System Events endpoint
  app.get('/v1/system/events', createSystemEventsHandler());

  // Config endpoints
  app.get('/config', createConfigGetHandler());
  app.post('/config/store', createConfigStoreHandler(router));

  // Logs endpoint
  app.get('/logs', createLogsHandler());

  // Media generation endpoints
  app.post('/v1/images/generations', createImagesHandler(router));
  app.post('/v1/audio/speech', createAudioSpeechHandler(router));
  app.post('/v1/videos/generations', createVideosHandler(router));

  // Non-existent routes
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    const isExpectedError = err.status && err.status >= 400 && err.status < 500;
    
    if (isExpectedError) {
      logger.warn(`[${err.status}] ${err.message || 'Client error'}`, {}, 'Server');
    } else {
      // Use safe logging to prevent binary data from hitting logs
      const safeMeta = sanitizeForLogging({ 
        stack: err.stack,
        status: err.status,
        code: err.code
      });
      logger.error(`Unhandled server error: ${err.message}`, null, safeMeta, 'Server');
    }
    
    if (res.headersSent) {
      return next(err);
    }
    
    let status = err.status || 500;
    
    // Parse error messages for specific status codes
    if (!err.status && err.message) {
      const msg = err.message;
      if (msg.includes('413 Payload Too Large')) status = 413;
      else if (msg.includes('Unknown model')) status = 404;
      else if (msg.includes('does not support')) status = 400;
      else if (msg.includes('Circuit is OPEN')) status = 503;
      else if (msg.includes('429') || msg.includes('Too Many Requests')) status = 429;
      else if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) status = 502;
    }

    res.status(status).json({ error: err.message || 'Internal Server Error' });
  });

  return app;
}
