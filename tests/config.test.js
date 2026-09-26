import { expect } from 'chai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createConfigStoreHandler } from '../src/routes/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Configuration Manager', () => {
  let originalEnv;

  beforeEach(() => {
    // Preserve original environment variables
    originalEnv = process.env;
    process.env = { ...originalEnv };
    // Set required API keys for testing
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.GROK_API_KEY = 'test-grok-key';
    process.env.GLM_API_KEY = 'test-glm-key';
    process.env.QWEN_API_KEY = 'test-qwen-key';
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
  });

  afterEach(() => {
    // Restore original environment variables
    process.env = originalEnv;
  });

  it('should load actual configuration without throwing', async () => {
    const config = await loadConfig();
    expect(config).to.be.an('object');
    // Check fundamental properties that should exist in new model-centric config
    expect(config).to.have.property('port');
    expect(config).to.have.property('host');
    expect(config).to.have.property('models');
    expect(config.models).to.be.an('object');
    expect(Object.keys(config.models).length).to.be.greaterThan(0);
  });

  it('should appropriately substitute environment variables using real workflow', async () => {
    // Test variable substitution on a dynamically created temporary config
    const tempConfigPath = path.resolve(__dirname, '../config.json');
    const existingConfigData = await fs.readFile(tempConfigPath, 'utf8');
    const savedConfigData = existingConfigData;
    
    try {
      // Modify actual config for this test case
      const parsedConfig = JSON.parse(existingConfigData);
      // Update a model's API key to use env var
      const modelKey = Object.keys(parsedConfig.models).find(k => !k.startsWith('_comment'));
      parsedConfig.models[modelKey].apiKey = '${TEST_DYNAMIC_KEY}';
      await fs.writeFile(tempConfigPath, JSON.stringify(parsedConfig, null, 2), 'utf8');

      // Set the OS environment variable
      process.env.TEST_DYNAMIC_KEY = 'super-secret-key-123';

      // Load config (processes real file + environment substitution)
      const config = await loadConfig();

      // Ensure substitution works in the actual output
      expect(config.models[modelKey].apiKey).to.equal('super-secret-key-123');

    } finally {
      // Restore the original config structure safely
      await fs.writeFile(tempConfigPath, savedConfigData, 'utf8');
    }
  });

  it('should have valid model configurations', async () => {
    const config = await loadConfig();
    
    for (const [modelId, modelConfig] of Object.entries(config.models)) {
      if (modelId.startsWith('_comment')) continue;
      expect(modelConfig).to.have.property('type');
      expect(modelConfig).to.have.property('adapter');
      expect(modelConfig).to.have.property('capabilities');
      
      if (modelConfig.type === 'chat' || modelConfig.type === 'embedding') {
        expect(modelConfig.capabilities).to.have.property('contextWindow');
      }
      
      // Verify type is valid
      expect(['chat', 'embedding', 'image']).to.include(modelConfig.type);
      
      // Verify adapter is valid
      expect(['gemini', 'openai', 'anthropic', 'responses']).to.include(modelConfig.adapter);
    }
  });
});

describe('Config store handler', () => {
  const configPath = path.resolve(__dirname, '../config.json');

  function makeReq(body) {
    return { body, socket: { remoteAddress: '127.0.0.1' } };
  }

  function makeRes() {
    const res = { statusCode: null, payload: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => { res.payload = data; return res; };
    return res;
  }

  it('rejects an invalid payload with 400 and never writes it to disk', async () => {
    const before = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(before);
    // Reproduces the 2026-09-25 muse-image incident: model without capabilities
    parsed.models['test-invalid-model'] = {
      prettyName: 'Invalid', type: 'image', adapter: 'openai',
      endpoint: 'https://example.com', adapterModel: 'x/y'
    };

    const router = { reloadConfig() { throw new Error('reloadConfig must not run'); } };
    const handler = createConfigStoreHandler(router);
    const nextErrors = [];
    const res = makeRes();

    try {
      await handler(makeReq(parsed), res, (err) => nextErrors.push(err));
    } finally {
      // Disk must be untouched regardless of outcome
      const after = await fs.readFile(configPath, 'utf8');
      expect(after).to.equal(before);
    }

    expect(nextErrors).to.have.lengthOf(1);
    expect(nextErrors[0].message).to.include('missing required field "capabilities"');
    expect(nextErrors[0].status).to.equal(400);
  });

  it('accepts a valid payload, saves and reloads', async () => {
    const before = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(before);

    const router = { reloaded: null, reloadConfig(cfg) { this.reloaded = cfg; } };
    const handler = createConfigStoreHandler(router);
    const res = makeRes();
    const nextErrors = [];

    try {
      await handler(makeReq(parsed), res, (err) => nextErrors.push(err));
    } finally {
      // Restore in case assertion below fails mid-write
      await fs.writeFile(configPath, before, 'utf8');
    }

    expect(nextErrors).to.have.lengthOf(0);
    expect(res.payload).to.have.property('success', true);
    expect(router.reloaded).to.be.an('object');
  });
});
