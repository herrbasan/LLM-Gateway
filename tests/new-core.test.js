/**
 * Tests for new model-centric core components.
 */

import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { validateConfig, validateModelConfig, resolveEnvVars } from '../src/core/config-schema.js';
import { ModelRegistry } from '../src/core/model-registry.js';
import { ModelRouter } from '../src/core/model-router.js';

const VALID_CONFIG = {
    models: {
        'gemini-flash': {
            type: 'chat',
            adapter: 'gemini',
            endpoint: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: '${GEMINI_API_KEY}',
            adapterModel: 'gemini-2.0-flash-001',
            capabilities: {
                contextWindow: 1048576,
                vision: true,
                structuredOutput: 'json_schema',
                streaming: true
            }
        },
        'gemini-embedding': {
            type: 'embedding',
            adapter: 'gemini',
            endpoint: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: '${GEMINI_API_KEY}',
            adapterModel: 'embedding-001',
            capabilities: {
                contextWindow: 2048,
                dimensions: 768
            }
        },
        'dall-e-3': {
            type: 'image',
            adapter: 'openai',
            endpoint: 'https://api.openai.com/v1',
            apiKey: '${OPENAI_API_KEY}',
            capabilities: {
                maxResolution: '1024x1024',
                supportedFormats: ['png', 'jpeg']
            }
        },
        'local-llama': {
            type: 'chat',
            adapter: 'openai',
            endpoint: 'http://localhost:11434',
            capabilities: {
                contextWindow: 128000,
                vision: false,
                structuredOutput: false,
                streaming: true
            }
        }
    },
    thinking: {
        enabled: true,
        stripTags: ['think', 'thinking', 'thought', 'reasoning'],
        orphanCloseAsSeparator: true
    },
    tasks: {
        query: {
            model: 'gemini-flash',
            description: 'Default chat task',
            default: true
        },
        embed: {
            model: 'gemini-embedding',
            description: 'Default embedding task',
            default: true
        },
        image: {
            model: 'dall-e-3',
            description: 'Default image task',
            default: true
        }
    }
};

describe('Config Schema', () => {
    describe('validateModelConfig', () => {
        it('should validate a valid chat model', () => {
            const config = {
                type: 'chat',
                adapter: 'gemini',
                endpoint: 'https://api.example.com',
                capabilities: {
                    contextWindow: 100000,
                    vision: true,
                    streaming: true
                }
            };
            expect(() => validateModelConfig('test-model', config)).to.not.throw();
        });

        it('should throw on missing required field', () => {
            const config = {
                type: 'chat',
                adapter: 'gemini'
                // missing endpoint and capabilities
            };
            expect(() => validateModelConfig('test-model', config))
                .to.throw('missing required field');
        });

        it('should throw on invalid type', () => {
            const config = {
                type: 'invalid-type',
                adapter: 'gemini',
                endpoint: 'https://api.example.com',
                capabilities: { contextWindow: 1000 }
            };
            expect(() => validateModelConfig('test-model', config))
                .to.throw('invalid type');
        });

        it('should throw on unknown adapter', () => {
            const config = {
                type: 'chat',
                adapter: 'unknown-adapter',
                endpoint: 'https://api.example.com',
                capabilities: { contextWindow: 1000 }
            };
            expect(() => validateModelConfig('test-model', config))
                .to.throw('unknown adapter');
        });

        it('should throw on invalid contextWindow', () => {
            const config = {
                type: 'chat',
                adapter: 'gemini',
                endpoint: 'https://api.example.com',
                capabilities: { contextWindow: 'not-a-number' }
            };
            expect(() => validateModelConfig('test-model', config))
                .to.throw('contextWindow must be a positive number');
        });
    });

    describe('validateConfig', () => {
        it('should validate complete config', () => {
            expect(() => validateConfig(VALID_CONFIG)).to.not.throw();
        });

        it('should throw on missing models section', () => {
            expect(() => validateConfig({}))
                .to.throw('Missing or invalid "models" section');
        });

        it('should throw on invalid task model', () => {
            const config = {
                ...VALID_CONFIG,
                tasks: {
                    ...VALID_CONFIG.tasks,
                    query: { model: 'non-existent-model', default: true }
                }
            };
            expect(() => validateConfig(config))
                .to.throw('does not exist in models');
        });
    });

    describe('resolveEnvVars', () => {
        it('should resolve environment variables', () => {
            process.env.TEST_VAR = 'test-value';
            const result = resolveEnvVars('prefix-${TEST_VAR}-suffix');
            expect(result).to.equal('prefix-test-value-suffix');
            delete process.env.TEST_VAR;
        });

        it('should throw on unset environment variable', () => {
            expect(() => resolveEnvVars('${UNSET_VAR_xyz}'))
                .to.throw('Environment variable "UNSET_VAR_xyz" is not set');
        });

        it('should return non-strings unchanged', () => {
            expect(resolveEnvVars(123)).to.equal(123);
            expect(resolveEnvVars(null)).to.equal(null);
        });
    });
});

describe('ModelRegistry', () => {
    let registry;

    beforeEach(() => {
        process.env.GEMINI_API_KEY = 'test-gemini-key';
        process.env.OPENAI_API_KEY = 'test-openai-key';
        registry = new ModelRegistry(VALID_CONFIG);
    });

    it('should initialize with models', () => {
        expect(registry.getModelIds()).to.have.length(4);
    });

    it('should get model by ID', () => {
        const model = registry.get('gemini-flash');
        expect(model.type).to.equal('chat');
        expect(model.adapter).to.equal('gemini');
    });

    it('should throw on unknown model', () => {
        expect(() => registry.get('unknown-model'))
            .to.throw('Unknown model');
    });

    it('should check model existence', () => {
        expect(registry.has('gemini-flash')).to.be.true;
        expect(registry.has('unknown')).to.be.false;
    });

    it('should get models by type', () => {
        const chatModels = registry.getByType('chat');
        expect(chatModels).to.have.length(2);
        
        const embeddingModels = registry.getByType('embedding');
        expect(embeddingModels).to.have.length(1);
    });

    it('should resolve model with type check', () => {
        const { id, config } = registry.resolveModel('gemini-flash', 'chat');
        expect(id).to.equal('gemini-flash');
        expect(config.type).to.equal('chat');
    });

    it('should throw when no model specified (task system handles defaults)', () => {
        expect(() => registry.resolveModel(null, 'chat'))
            .to.throw('No model specified');
    });

    it('should throw on type mismatch', () => {
        expect(() => registry.resolveModel('gemini-embedding', 'chat'))
            .to.throw('type "embedding", expected "chat"');
    });

    it('should return OpenAI-compatible model list', () => {
        const list = registry.listModels();
        expect(list.object).to.equal('list');
        expect(list.data).to.have.length(4);
        const model = list.data[0];
        expect(model).to.have.property('id');
        expect(model).to.have.property('capabilities');
        // v2.1: Context window exposed at multiple paths for compatibility
        expect(model).to.have.property('maxInputTokens');
        expect(model).to.have.property('contextWindow');
        expect(model).to.have.property('context_length');
        expect(model).to.have.property('maxOutputTokens');
        expect(model).to.have.property('limit');
        expect(model.limit).to.have.property('context');
    });

    it('should return global config', () => {
        expect(registry.getThinkingConfig().enabled).to.be.true;
        const defaultTasks = registry.getTaskRegistry().getDefaultTasks();
        expect(defaultTasks).to.have.length.greaterThan(0);
        const chatDefault = defaultTasks.find(t => t.id === 'query');
        expect(chatDefault).to.not.be.undefined;
        expect(chatDefault.config.model).to.equal('gemini-flash');
    });
});

describe('ModelRouter', () => {
    let router;

    beforeEach(() => {
        process.env.GEMINI_API_KEY = 'test-gemini-key';
        process.env.OPENAI_API_KEY = 'test-openai-key';
        router = new ModelRouter(VALID_CONFIG);
    });

    it('should initialize with registry and adapters', () => {
        expect(router.registry).to.be.instanceOf(ModelRegistry);
        expect(router.adapters).to.be.instanceOf(Map);
    });

    it('should throw on missing config', () => {
        expect(() => new ModelRouter(null))
            .to.throw('Config is required');
    });

    it('should throw on invalid request', async () => {
        try {
            await router.routeChatCompletion(null);
            expect.fail('Should have thrown');
        } catch (err) {
            expect(err.message).to.include('Request must be an object');
        }
    });

    it('should throw on missing prompt for image generation', async () => {
        try {
            await router.routeImageGeneration({});
            expect.fail('Should have thrown');
        } catch (err) {
            expect(err.message).to.include('Missing required field: prompt');
        }
    });

    it('should list models', async () => {
        const list = await router.listModels();
        expect(list.object).to.equal('list');
        expect(list.data).to.have.length(4);
    });

    it('should prefer native whole-message token counting when available', async () => {
        const count = await router._estimateMessagesTokens(
            [{ role: 'user', content: 'Hello' }],
            {
                countMessageTokens: async () => 4321
            },
            VALID_CONFIG.models['gemini-flash']
        );

        expect(count).to.equal(4321);
    });
});
