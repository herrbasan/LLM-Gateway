import { expect } from 'chai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Configuration Manager', () => {
  let originalEnv;

  beforeEach(() => {
    // Preserve original environment variables
    originalEnv = process.env;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment variables
    process.env = originalEnv;
  });

  it('should load actual configuration without throwing', async () => {
    const config = await loadConfig();
    expect(config).to.be.an('object');
    // We check fundamental properties that should exist in a real config
    expect(config).to.have.property('port');
    expect(config).to.have.property('host');
    expect(config).to.have.property('providers');
  });

  it('should appropriately substitute environment variables using real workflow', async () => {
    // We test variable substitution on a dynamically created temporary config mimicking the real setup process
    // This avoids mocking `fs.readFile` and tests the real module IO behavior
    
    // Create a temporary "real" config state
    const tempConfigPath = path.resolve(__dirname, '../config.json');
    const existingConfigData = await fs.readFile(tempConfigPath, 'utf8');
    const savedConfigData = existingConfigData; // Keep original to restore later
    
    try {
      // Modify actual config for this test case
      const parsedConfig = JSON.parse(existingConfigData);
      parsedConfig.providers.gemini.apiKey = '${TEST_DYNAMIC_KEY}';
      await fs.writeFile(tempConfigPath, JSON.stringify(parsedConfig, null, 2), 'utf8');

      // Set the OS environment variable
      process.env.TEST_DYNAMIC_KEY = 'super-secret-key-123';

      // Load config (processes real file + environment substitution)
      const config = await loadConfig();

      // Ensure substitution works in the actual output
      expect(config.providers.gemini.apiKey).to.equal('super-secret-key-123');

    } finally {
      // Restore the original config structure safely
      await fs.writeFile(tempConfigPath, savedConfigData, 'utf8');
    }
  });
});
