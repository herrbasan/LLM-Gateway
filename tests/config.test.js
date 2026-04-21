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
      const modelKey = Object.keys(parsedConfig.models)[0];
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
      expect(modelConfig).to.have.property('type');
      expect(modelConfig).to.have.property('adapter');
      expect(modelConfig).to.have.property('capabilities');
      
      if (modelConfig.type === 'chat' || modelConfig.type === 'embedding') {
        expect(modelConfig.capabilities).to.have.property('contextWindow');
      }
      
      // Verify type is valid
      expect(['chat', 'embedding', 'image', 'audio', 'video']).to.include(modelConfig.type);
      
      // Verify adapter is valid
      expect(['gemini', 'openai', 'ollama', 'lmstudio', 'minimax', 'kimi-cli', 'anthropic', 'alibaba', 'dashscope', 'responses', 'kimi', 'llamacpp']).to.include(modelConfig.adapter);
    }
  });
});
