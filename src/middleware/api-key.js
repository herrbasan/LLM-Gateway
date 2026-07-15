import { getLogger } from '../utils/logger.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const logger = getLogger();

/**
 * Reads GATEWAY_ACCESS_KEY directly from the .env file.
 * Bypasses process.env because dotenv ESM loading is unreliable in this codebase.
 */
function readAccessKeyFromEnvFile() {
  try {
    const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.slice(0, eqIdx).trim();
      if (key !== 'GATEWAY_ACCESS_KEY') continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    logger.warn('[Auth] .env file not found or unreadable', {}, 'Auth');
  }
  return null;
}

/**
 * Express middleware — enforces API key on all protected routes.
 *
 * Key priority: config.ws.accessKey > .env file > process.env (legacy).
 * If no key is configured anywhere, every protected request gets 401.
 * Public: /health, /help.
 */
export function createApiKeyMiddleware(config) {
  const expectedKey =
    (config.ws?.accessKey && String(config.ws.accessKey).trim()) ||
    readAccessKeyFromEnvFile() ||
    (process.env.GATEWAY_ACCESS_KEY && String(process.env.GATEWAY_ACCESS_KEY).trim()) ||
    null;

  logger.info('[Auth] API key middleware active', {
    keySource: config.ws?.accessKey ? 'config' : expectedKey ? 'env' : 'none',
  }, 'Auth');

  if (!expectedKey) {
    logger.warn('[Auth] No API key configured — all protected routes will return 401', {}, 'Auth');
  }

  const publicPaths = new Set(['/health', '/help']);

  return (req, res, next) => {
    if (publicPaths.has(req.path)) return next();

    const authHeader = req.headers.authorization || '';
    const headerKey = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
    const suppliedKey = headerKey ?? req.query?.access_key;

    if (!expectedKey || suppliedKey !== expectedKey) {
      const ip = req.socket.remoteAddress || req.ip;
      logger.warn('Unauthorized REST API request', { ip, path: req.path }, 'Auth');
      return res.status(401).json({ error: 'Unauthorized: invalid or missing access key' });
    }

    next();
  };
}
