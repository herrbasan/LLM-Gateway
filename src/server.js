import express from 'express';
import { createHealthHandler } from './routes/health.js';
import { createChatHandler } from './routes/chat.js';
import { createEmbeddingsHandler } from './routes/embeddings.js';
import { createModelsHandler } from './routes/models.js';
import { createSessionsHandler, createSessionIdHandler } from './routes/sessions.js';
import { createTasksHandler, createTasksStreamHandler } from './routes/tasks.js';
import { SessionStore } from './core/session.js';
import { Router } from './core/router.js';
import { TicketRegistry } from './core/ticket-registry.js';

export function createServer(config) {
  const app = express();
  const sessionStore = new SessionStore(config);
  const ticketRegistry = new TicketRegistry();

  // Centralized Router so Adapters/Circuit-Breakers are shared across routes
  const router = new Router(config, sessionStore, ticketRegistry);

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
  app.post('/v1/sessions', createSessionsHandler(sessionStore, router));
  app.get('/v1/sessions/:id', createSessionIdHandler(sessionStore, router));
  app.patch('/v1/sessions/:id', createSessionIdHandler(sessionStore, router));
  app.delete('/v1/sessions/:id', createSessionIdHandler(sessionStore, router));
  app.post('/v1/sessions/:id/compress', createSessionIdHandler(sessionStore, router));

  // Tasks endpoints
  app.get('/v1/tasks/:id', createTasksHandler(ticketRegistry));
  app.get('/v1/tasks/:id/stream', createTasksStreamHandler(ticketRegistry));

  // Non-existent routes
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    const isExpectedError = err.status && err.status >= 400 && err.status < 500;
    const isProviderFallback = err.message?.includes('model "auto" not found') || 
                                err.message?.includes('is not found for API version');
    
    // Log expected errors (like 404s from provider fallbacks) as warnings
    // Log unexpected errors as errors
    if (isProviderFallback || (isExpectedError && err.status === 404)) {
      console.warn(`[${err.status || 502}] ${err.message || 'Provider fallback'}`);
    } else if (isExpectedError) {
      console.warn(`[${err.status}] ${err.message || 'Client error'}`);
    } else {
      console.error('Unhandled server error:', err.message || err);
    }
    
    if (res.headersSent) {
      return next(err);
    }
    
    let status = err.status || 500;
    
    // Parse error messages for specific status codes if not explicitly set
    if (!err.status && err.message) {
      const msg = err.message;
      if (msg.includes('413 Payload Too Large')) status = 413;
      else if (msg.includes('404 Session Not Found') || msg.includes('No adapter found') || msg.includes('Not Found') || msg.includes('No matching provider')) status = 404;
      else if (msg.includes('does not support structured output') || msg.includes('does not support embeddings')) status = 400;
      else if (msg.includes('Circuit is OPEN') || msg.includes('Service Unavailable') || msg.includes('Circuit breaker')) status = 503;
      else if (msg.includes('429') || msg.includes('queue full') || msg.includes('Too Many Requests')) status = 429;
      else if (msg.includes('connection failure') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('Bad Gateway') || msg.includes('Gateway Timeout') || msg.includes('socket hang up') || msg.includes('fetch failed')) status = 502;
    }

    const errorMsg = err.message || 'Internal Server Error';
    
    // For specific errors like 503 Fast Fail, allow message through
    res.status(status).json({ error: errorMsg });
  });

  return app;
}
