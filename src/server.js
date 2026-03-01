import express from 'express';
import { createHealthHandler } from './routes/health.js';
import { createChatHandler } from './routes/chat.js';
import { createEmbeddingsHandler } from './routes/embeddings.js';
import { createModelsHandler } from './routes/models.js';
import { createSessionsHandler, createSessionIdHandler } from './routes/sessions.js';
import { SessionStore } from './core/session.js';
import { Router } from './core/router.js';

export function createServer(config) {
  const app = express();
  const sessionStore = new SessionStore(config);

  // Centralized Router so Adapters/Circuit-Breakers are shared across routes
  const router = new Router(config, sessionStore);

  // Basic middleware
  app.use(express.json({ limit: '10mb' }));
  
  // CORS could be added here if needed, keeping it simple for now as requested
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Provider, X-Session-Id, X-Async');
    if (req.method === 'OPTIONS') {
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      return res.status(200).json({});
    }
    next();
  });

  // Basic health endpoint
  app.get('/health', createHealthHandler(config, router));

  // Chat completions endpoint
  app.post('/v1/chat/completions', createChatHandler(router, sessionStore));

  // Embeddings endpoint
  app.post('/v1/embeddings', createEmbeddingsHandler(router));

  // Models endpoint
  app.get('/v1/models', createModelsHandler(router));

  // Sessions endpoints
  app.post('/v1/sessions', createSessionsHandler(sessionStore));
  app.get('/v1/sessions/:id', createSessionIdHandler(sessionStore));
  app.patch('/v1/sessions/:id', createSessionIdHandler(sessionStore));
  app.delete('/v1/sessions/:id', createSessionIdHandler(sessionStore));

  // Non-existent routes
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err.message || err);
    if (res.headersSent) {
      return next(err);
    }
    const status = err.status || 500;
    const errorMsg = status >= 500 
      ? (err.message || 'Internal Server Error') 
      : 'Internal Server Error';
    
    // For specific errors like 503 Fast Fail, allow message through
    res.status(status).json({ error: err.message || 'Internal Server Error' });
  });

  return app;
}
