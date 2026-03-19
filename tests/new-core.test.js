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
            adapter: 'ollama',
            endpoint: 'http://localhost:11434',
            adapterModel: 'llama3.2',
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
    compaction: {
        enabled: true,
        mode: 'truncate',
        minTokensToCompact: 2000,
        preserveSystemPrompt: true,
        preserveLastN: 4
    },
    routing: {
        defaultChatModel: 'gemini-flash',
        defaultEmbeddingModel: 'gemini-embedding',
        defaultImageModel: 'dall-e-3'
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

        it('should throw on invalid routing default', () => {
            const config = {
                ...VALID_CONFIG,
                routing: {
                    defaultChatModel: 'non-existent-model'
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

    it('should resolve default model when not specified', () => {
        const { id, config } = registry.resolveModel(null, 'chat');
        expect(id).to.equal('gemini-flash');
    });

    it('should throw on type mismatch', () => {
        expect(() => registry.resolveModel('gemini-embedding', 'chat'))
            .to.throw('type "embedding", expected "chat"');
    });

    it('should return OpenAI-compatible model list', () => {
        const list = registry.listModels();
        expect(list.object).to.equal('list');
        expect(list.data).to.have.length(4);
        expect(list.data[0]).to.have.property('id');
        expect(list.data[0]).to.have.property('capabilities');
    });

    it('should return global config', () => {
        expect(registry.getThinkingConfig().enabled).to.be.true;
        expect(registry.getCompactionConfig().enabled).to.be.true;
        expect(registry.getRoutingConfig().defaultChatModel).to.equal('gemini-flash');
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

    it('should preserve explicit max_tokens when resolving chat options', () => {
        const resolved = router._resolveChatMaxTokens(
            { max_tokens: 2048 },
            VALID_CONFIG.models['gemini-flash'],
            { used_tokens: 1000 }
        );

        expect(resolved).to.equal(2048);
    });

    it('should derive implicit max_tokens from remaining context budget', () => {
        const resolved = router._resolveChatMaxTokens(
            {},
            VALID_CONFIG.models['gemini-flash'],
            { used_tokens: 400000 }
        );

        expect(resolved).to.equal(438861);
    });

    it('should clamp implicit max_tokens to at least one token', () => {
        const resolved = router._resolveChatMaxTokens(
            {},
            VALID_CONFIG.models['gemini-flash'],
            { used_tokens: 1048576 }
        );

        expect(resolved).to.equal(1);
    });

    it('should annotate context with resolved implicit max_tokens', () => {
        const context = router._annotateContext(
            {
                window_size: 1048576,
                used_tokens: 400000,
                available_tokens: 648576,
                strategy_applied: false
            },
            438861,
            {}
        );

        expect(context).to.include({
            resolved_max_tokens: 438861,
            max_tokens_source: 'implicit'
        });
    });

    it('should annotate context with explicit max_tokens source', () => {
        const context = router._annotateContext(null, 2048, { max_tokens: 2048 });

        expect(context).to.deep.equal({
            resolved_max_tokens: 2048,
            max_tokens_source: 'explicit'
        });
    });
});
