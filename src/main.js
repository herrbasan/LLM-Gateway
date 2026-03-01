import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main() {
  try {
    const config = await loadConfig();
    const server = createServer(config);
    
    server.listen(config.port, config.host, () => {
      console.log(`LLM Gateway running on http://${config.host}:${config.port}`);
    });

    const shutdown = () => {
      console.log('Shutting down...');
      server.close(() => {
        process.exit(0);
      });
      // Force exit after 5s
      setTimeout(() => process.exit(1), 5000);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    console.error('Failed to start LLM Gateway:', error);
    process.exit(1);
  }
}

main();
