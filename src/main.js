import dotenv from 'dotenv';
dotenv.config();

import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { createLogger } from './utils/logger.js';

async function main() {
  // Initialize logger first - creates timestamped log file
  const logger = createLogger();
  
    logger.info('Starting LLM Gateway', { 
      nodeEnv: process.env.NODE_ENV || 'development',
      nodeVersion: process.version 
    }, 'System');
    
    const config = await loadConfig();
    logger.info('Configuration loaded', { 
      port: config.port, 
      host: config.host,
      modelsConfigured: Object.keys(config.models || {}).length 
    }, 'System');
    
    const app = createServer(config);

    const server = app.listen(config.port, config.host, () => {
      logger.info('Gateway started', {
        url: `http://${config.host}:${config.port}`,
        logFile: logger.getSessionInfo().logFile
      }, 'System');
      console.log(`LLM Gateway running on http://${config.host}:${config.port}`);
      console.log(`Log file: ${logger.getSessionInfo().logFile}`);
    });

    // Initialize WebSocket Server
    const { setupWebSocketServer } = await import('./websocket/server.js');
    const wsServer = setupWebSocketServer(server, app, config, {
      router: app.locals.router,
      ticketRegistry: app.locals.ticketRegistry
    });

    const shutdown = (signal) => {
      logger.info(`Received ${signal}, shutting down...`, {}, 'System');
      if (wsServer && wsServer.shutdown) {
        try { wsServer.shutdown(); } catch(e) {}
      }
      server.close(() => {
        logger.close();
        process.exit(0);
      });
      // Force exit after 5s
      setTimeout(() => {
        logger.error('Forced shutdown after timeout', null, null, 'System');
        logger.close();
        process.exit(1);
      }, 5000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Log uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', error, null, 'System');
      logger.close();
      process.exit(1);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection', null, { reason, promise }, 'System');
    });

}

main();
