/**
 * Adapter Tests - Real World
 * Tests actual adapter behavior with real API calls when credentials available.
 * No mocks. Fail fast on errors.
 */

import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import { createAdapters } from '../src/core/adapters.js';
import { loadConfig } from '../src/config.js';

const hasCredentials = (modelConfig) => {
    if (!modelConfig.apiKey) return false;
    if (modelConfig.apiKey.includes('${')) return false;
    // Real credentials don't contain the word 'test'
    if (modelConfig.apiKey.toLowerCase().includes('test')) return false;
    return true;
};

describe('Adapters v2 - Real World', () => {
    let adapters;
    let config;
    let geminiModel;

    before(async () => {
        config = await loadConfig();
        adapters = createAdapters();
        geminiModel = Object.values(config.models || {}).find(m => m.adapter === 'gemini' && m.type === 'chat');
    });

    describe('Adapter Factory', () => {
        it('should create all adapter types', () => {
            expect(adapters.has('gemini')).to.be.true;
            expect(adapters.has('openai')).to.be.true;
            expect(adapters.has('ollama')).to.be.true;
            expect(adapters.has('lmstudio')).to.be.true;
            expect(adapters.has('minimax')).to.be.true;
            expect(adapters.has('kimi-cli')).to.be.true;
        });

        it('should have correct interface on each adapter', () => {
            for (const [name, adapter] of adapters.entries()) {
                expect(adapter).to.have.property('name', name);
                expect(adapter.chatComplete).to.be.a('function');
                expect(adapter.streamComplete).to.be.a('function');
                expect(adapter.createEmbedding).to.be.a('function');
            }
        });
    });

    describe('Gemini Adapter - Live', function() {
        this.timeout(30000);
        
        before(function() {
            if (!geminiModel || !hasCredentials(geminiModel)) {
                console.log('[SKIP] Gemini credentials not available');
                this.skip();
            }
        });

        it('should complete chat', async () => {
            const adapter = adapters.get('gemini');
            const result = await adapter.chatComplete(geminiModel, {
                messages: [{ role: 'user', content: 'Say exactly: TEST_PASS' }]
            });

            expect(result).to.have.property('id');
            expect(result).to.have.property('object', 'chat.completion');
            expect(result.choices[0].message.content).to.include('TEST');
        });

        it('should stream chat', async () => {
            const adapter = adapters.get('gemini');
            const generator = adapter.streamComplete(geminiModel, {
                messages: [{ role: 'user', content: 'Count: 1 2 3' }]
            });

            let chunks = 0;
            let content = '';

            for await (const chunk of generator) {
                chunks++;
                content += chunk.choices?.[0]?.delta?.content || '';
            }

            expect(chunks).to.be.greaterThan(0);
            expect(content.length).to.be.greaterThan(0);
        });

        it('should create embeddings if model supports it', async function() {
            if (!config.models) {
                this.skip();
            }
            const embedModel = Object.values(config.models).find(
                m => m.adapter === 'gemini' && m.type === 'embedding'
            );
            
            if (!embedModel) {
                this.skip();
            }

            const adapter = adapters.get('gemini');
            const result = await adapter.createEmbedding(embedModel, {
                input: 'Hello world'
            });

            expect(result).to.have.property('object', 'list');
            expect(result.data).to.be.an('array');
            expect(result.data[0].embedding).to.be.an('array');
        });
    });

    describe('OpenAI Adapter - Live', function() {
        this.timeout(30000);
        let openaiModel;

        before(async function() {
            openaiModel = Object.values(config.models || {}).find(
                m => m.adapter === 'openai' && m.type === 'chat'
            );
            if (!openaiModel || !hasCredentials(openaiModel)) {
                console.log('[SKIP] OpenAI-compatible credentials not available');
                this.skip();
            }
        });

        it('should complete chat', async () => {
            const adapter = adapters.get('openai');
            const result = await adapter.chatComplete(openaiModel, {
                messages: [{ role: 'user', content: 'Say exactly: TEST_PASS' }]
            });

            expect(result).to.have.property('choices');
            expect(result.choices[0].message.content).to.include('TEST');
        });
    });

    describe('Ollama Adapter - Live (Local)', function() {
        this.timeout(30000);
        let ollamaModel;

        before(async () => {
            ollamaModel = Object.values(config.models || {}).find(
                m => m.adapter === 'ollama' && m.type === 'chat'
            );
        });

        it('should connect to local Ollama if running', async function() {
            if (!ollamaModel) {
                this.skip();
            }

            const adapter = adapters.get('ollama');
            
            try {
                const result = await adapter.chatComplete(ollamaModel, {
                    messages: [{ role: 'user', content: 'Hi' }]
                });
                
                expect(result).to.have.property('choices');
            } catch (err) {
                if (err.message.includes('ECONNREFUSED')) {
                    console.log('[SKIP] Ollama not running locally');
                    this.skip();
                }
                throw err;
            }
        });
    });
});
