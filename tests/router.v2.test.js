/**
 * ModelRouter Tests - Real World
 * Tests routing with real config, real adapters.
 * No mocks where possible. Fail fast.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ModelRouter } from '../src/core/model-router.js';
import { loadConfig } from '../src/config.js';

describe('ModelRouter v2 - Real World', () => {
    let router;
    let config;

    before(async () => {
        config = await loadConfig();
        router = new ModelRouter(config);
    });

    describe('Model Resolution', () => {
        it('resolves chat model by ID', () => {
            const chatModel = Object.keys(config.models).find(
                id => config.models[id].type === 'chat'
            );
            
            const result = router.registry.resolveModel(chatModel, 'chat');
            expect(result.id).to.equal(chatModel);
            expect(result.config.type).to.equal('chat');
        });

        it('resolves default chat model via task when not specified', () => {
            const defaultTasks = router.registry.getTaskRegistry().getDefaultTasks();
            const chatDefault = defaultTasks.find(t => {
                const model = router.registry.get(t.config.model);
                return model && model.type === 'chat';
            });
            if (!chatDefault) {
                console.log('[SKIP] No default chat task configured');
                return;
            }
            
            const result = router.registry.resolveModel(chatDefault.config.model, 'chat');
            expect(result.id).to.equal(chatDefault.config.model);
        });

        it('throws on unknown model', () => {
            expect(() => router.registry.resolveModel('nonexistent', 'chat'))
                .to.throw('Unknown model');
        });

        it('throws on type mismatch', () => {
            const embedModel = Object.keys(config.models).find(
                id => config.models[id].type === 'embedding'
            );
            
            if (!embedModel) {
                console.log('[SKIP] No embedding model to test');
                return;
            }

            expect(() => router.registry.resolveModel(embedModel, 'chat'))
                .to.throw('type "embedding", expected "chat"');
        });
    });

    describe('listModels()', () => {
        it('returns all models from config', async () => {
            const result = await router.listModels();
            
            expect(result.object).to.equal('list');
            expect(result.data).to.be.an('array');
            const expectedCount = Object.entries(config.models).filter(([k, m]) => !m.disabled && !k.startsWith('_comment')).length;
            expect(result.data.length).to.equal(expectedCount);
        });

        it('includes correct structure for each model', async () => {
            const result = await router.listModels();
            const model = result.data[0];
            
            expect(model).to.have.property('id');
            expect(model).to.have.property('object', 'model');
            expect(model).to.have.property('owned_by');
            expect(model).to.have.property('capabilities');
        });
    });

    describe('Adapter Access', () => {
        it('has all adapter types', () => {
            const expected = ['gemini', 'openai', 'anthropic', 'responses', 'llamacpp'];
            for (const type of expected) {
                expect(router.adapters.has(type), `Missing adapter: ${type}`).to.be.true;
            }
        });

        it('each adapter has circuit breakers', () => {
            for (const [name, adapter] of router.adapters.entries()) {
                expect(adapter.circuitBreakers, `Adapter ${name} missing circuit breakers`).to.exist;
                expect(adapter.circuitBreakers.chat, `Adapter ${name} missing chat breaker`).to.exist;
                expect(adapter.circuitBreakers.embed, `Adapter ${name} missing embed breaker`).to.exist;
            }
        });
    });

    describe('Removed Features', () => {
        it('getCompactionConfig is not exposed by the registry', () => {
            expect(router.registry.getCompactionConfig).to.be.undefined;
        });
    });
});
