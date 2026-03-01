import express from 'express';
import { createHealthHandler } from './routes/health.js';

export function createServer(config) {
  const app = express();

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
  app.get('/health', createHealthHandler(config));

  // Placeholder for future routes
  // app.post('/v1/chat/completions', chatHandler);
  // app.post('/v1/embeddings', embeddingsHandler);
  // app.get('/v1/models', modelsHandler);
  // app.post('/v1/sessions', sessionsHandler);
  
  // Non-existent routes
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}
