import { getRawConfig, saveRawConfig, loadConfig } from '../config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export function createConfigGetHandler() {
  return async (req, res, next) => {
    try {
      // Only allow localhost to access config directly
      const ip = req.socket.remoteAddress;
      const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!isLocalhost && !process.env.DEBUG_ALLOW_REMOTE_CONFIG) {
         logger.warn('Unauthorized config access attempt', { ip });
         return res.status(403).json({ error: 'Config access restricted to localhost' });
      }

      const rawConfig = await getRawConfig();
      res.json(rawConfig);
    } catch (error) {
      next(error);
    }
  };
}

export function createConfigStoreHandler(router) {
  return async (req, res, next) => {
    try {
      const ip = req.socket.remoteAddress;
      const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!isLocalhost && !process.env.DEBUG_ALLOW_REMOTE_CONFIG) {
         logger.warn('Unauthorized config store attempt', { ip });
         return res.status(403).json({ error: 'Config access restricted to localhost' });
      }

      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Invalid config payload' });
      }

      const newConfigPayload = req.body;
      logger.info('Saving new configuration payload from WebAdmin');
      
      // Save it as raw JSON 
      await saveRawConfig(newConfigPayload);

      // Load it normally to apply ENV vars to the router
      const substitutedConfig = await loadConfig();

      // Refresh the model router dynamically
      router.reloadConfig(substitutedConfig);
      
      logger.info('Gateway configuration successfully refreshed');
      res.json({ success: true, message: 'Configuration saved and reloaded' });
    } catch (error) {
      logger.error('Failed to save or reload config', { error: error.message });
      next(error);
    }
  };
}
