import { getRawConfig, saveRawConfig, loadConfig } from '../config.js';
import { validateConfig } from '../core/config-schema.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export function createConfigGetHandler() {
  return async (req, res, next) => {
    try {
      // Only allow localhost to access config directly
      const ip = req.socket.remoteAddress;
      const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!isLocalhost && !process.env.DEBUG_ALLOW_REMOTE_CONFIG) {
         logger.warn('Unauthorized config access attempt', { ip }, 'Config');
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
         logger.warn('Unauthorized config store attempt', { ip }, 'Config');
         return res.status(403).json({ error: 'Config access restricted to localhost' });
      }

      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Invalid config payload' });
      }

      const newConfigPayload = req.body;
      logger.info('Saving new configuration payload from WebAdmin', {}, 'Config');

      // Validate BEFORE anything touches disk. An invalid payload that reaches
      // config.json leaves the running router on its old in-memory config while
      // the file breaks the next cold start. Rejecting the raw payload is strictly
      // stronger than post-substitution validation: a field that passes raw holds
      // no ${ENV} placeholder, so substitution cannot change the verdict.
      try {
        validateConfig(newConfigPayload);
      } catch (error) {
        error.status = 400;
        throw error;
      }

      // Save it as raw JSON
      await saveRawConfig(newConfigPayload);

      // Load it normally to apply ENV vars to the router
      const substitutedConfig = await loadConfig();

      // Refresh the model router dynamically
      router.reloadConfig(substitutedConfig);
      
      logger.info('Gateway configuration successfully refreshed', {}, 'Config');
      res.json({ success: true, message: 'Configuration saved and reloaded' });
    } catch (error) {
      logger.error('Failed to save or reload config', null, { error: error.message }, 'Config');
      next(error);
    }
  };
}
