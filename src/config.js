import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function loadConfig() {
  const configPath = path.resolve(__dirname, '../config.json');
  try {
    const rawParams = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(rawParams);
    
    // Substitute environment variables in the config before returning
    const substituteEnvVars = (obj) => {
      for (const key in obj) {
        if (typeof obj[key] === 'string') {
          const matches = obj[key].match(/\$\{([^}]+)\}/g);
          if (matches) {
            let replaced = obj[key];
            for (const match of matches) {
              const envVar = match.slice(2, -1);
              if (process.env[envVar] !== undefined) {
                replaced = replaced.replace(match, process.env[envVar]);
              }
            }
            obj[key] = replaced;
          }
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          substituteEnvVars(obj[key]);
        }
      }
    };
    
    substituteEnvVars(parsed);
    
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Config file not found at ${configPath}. Please create one. (You can copy config.example.json)`);
    }
    throw new Error(`Failed to parse config: ${error.message}`);
  }
}
