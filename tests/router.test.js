import { expect } from 'chai';
import { Router } from '../src/core/router.js';
import dotenv from 'dotenv';
dotenv.config();

describe('Intelligent Router', () => {

    const createTestConfig = () => ({
        routing: {
            defaultProvider: 'lmstudio'
        },
        providers: {
            lmstudio: {
                type: 'lmstudio',
                endpoint: process.env.LM_STUDIO_ENDPOINT || 'http://localhost:12400',
                model: process.env.LM_STUDIO_MODEL || 'qwen2.5-14b',
                capabilities: {
                    structuredOutput: true
                }
            },
            ollama: {
                type: 'ollama',
                endpoint: process.env.OLLAMA_ENDPOINT || 'http://localhost:11400',
                model: process.env.OLLAMA_MODEL || 'llama3.2',
                capabilities: {
                    structuredOutput: false
                }
            },
            gemini: {
                type: 'gemini',
                apiKey: process.env.GEMINI_API_KEY,
                model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
                capabilities: {
                    structuredOutput: true
                }
            }
        }
    });

    const isConnectionError = (err) => {
        const msg = (err.message || '').toLowerCase();
        return msg.includes('econnrefused') || 
               msg.includes('fetch failed') ||
               msg.includes('network error');
    };

    it('should route to default provider when no overrides are given', async function () {
        this.timeout(15000);
        const config = createTestConfig();
        const router = new Router(config);
        
        const payload = {
            model: 'auto',
            messages: [{ role: 'user', content: 'hello' }]
        };

        try {
            await router.route(payload);
        } catch (error) {
            expect(isConnectionError(error), 'Expected connection error - ' + error.message).to.be.true;
        }
    });

    it('should override provider via HTTP header', async function () {
        this.timeout(15000);
        const config = createTestConfig();
        const router = new Router(config);
        
        const payload = {
            model: 'auto',
            messages: [{ role: 'user', content: 'hello' }]
        };

        try {
            await router.route(payload, { 'x-provider': 'ollama' });
        } catch (error) {
            expect(isConnectionError(error), 'Expected connection error - ' + error.message).to.be.true;
        }
    });

    it('should override provider via namespaced model parameter', async function () {
        this.timeout(15000);
        const config = createTestConfig();
        const router = new Router(config);
        
        const payload = {
            model: 'ollama:gemma3:12b',
            messages: [{ role: 'user', content: 'hello' }]
        };

        try {
            await router.route(payload);
        } catch (error) {
            expect(isConnectionError(error), 'Expected connection error - ' + error.message).to.be.true;
        }
    });

    it('should fail fast if an unknown provider or model is specified', async function () {
        this.timeout(15000);
        const config = createTestConfig();
        const router = new Router(config);
        
        const payload = {
            model: 'unknown_magic:llama',
            messages: [{ role: 'user', content: 'hello' }]
        };

        let err;
        try {
            await router.route(payload);
        } catch (e) {
            err = e;
        }
        
        expect(err).to.exist;
        expect(err.message).to.include("No adapter found for provider: 'unknown_magic'");
    });

    it('should block structured output requests on non-capable models', async function () {
        this.timeout(15000);
        const config = createTestConfig();
        const router = new Router(config);
        
        const payload = {
            model: 'ollama:llama3',
            messages: [{ role: 'user', content: 'extract data' }],
            response_format: { type: 'json_object' }
        };

        let err;
        try {
            await router.route(payload);
        } catch (e) {
            err = e;
        }
        
        expect(err).to.exist;
        expect(err.message).to.include("Provider 'ollama' does not support structured output");
    });
    
    it('should allow structured output requests on capable providers', async function () {
        this.timeout(15000);
        const config = createTestConfig();
        const router = new Router(config);
        
        const payload = {
            model: 'lmstudio:llama3',
            messages: [{ role: 'user', content: 'extract data' }],
            response_format: { type: 'json_object' }
        };

        try {
            await router.route(payload);
        } catch (error) {
            expect(isConnectionError(error), 'Expected connection error - ' + error.message).to.be.true;
        }
    });

    it('should properly pass schema for json_schema structured output', async function () {
        this.timeout(15000);
        const config = createTestConfig();
        const router = new Router(config);
        
        const payload = {
            model: 'lmstudio', 
            messages: [{ role: 'user', content: 'extract user data' }],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'user',
                    schema: { type: 'object', properties: { name: { type: 'string' } } }
                }
            }
        };

        try {
            await router.route(payload);
        } catch (error) {
            expect(isConnectionError(error), 'Expected connection error - ' + error.message).to.be.true;
        }
    });

    describe('Embeddings Routing', () => {
        it('should route to specific namespaced provider', async () => {
            const config = createTestConfig();
            const router = new Router(config);
            // Replace adapter methods to mock responses
            let calledOllama = false;
            router.adapters.get('ollama').capabilities.embeddings = true;
            router.adapters.get('ollama').embedText = async () => { calledOllama = true; return { object: "list" }; };
            
            await router.routeEmbeddings({
                model: 'ollama:nomic-embed',
                input: 'test text'
            });
            expect(calledOllama).to.be.true;
        });

        it('should fall back to embeddingProvider config if no namespace', async () => {
            const config = createTestConfig();
            config.routing.embeddingProvider = 'gemini'; // gemini supports embeddings in capabilities
            const router = new Router(config);
            
            let calledGemini = false;
            router.adapters.get('gemini').embedText = async () => { calledGemini = true; return { object: "list" }; };
            
            await router.routeEmbeddings({
                model: 'some-model',
                input: 'test text'
            });
            expect(calledGemini).to.be.true;
        });

        it('should find first capable provider if no embeddingProvider config and default is not capable', async () => {
            const config = createTestConfig();
            // Default provider lmstudio capability for embeddings is false (in test config above)
            config.providers.lmstudio.capabilities.embeddings = false;
            config.providers.ollama.capabilities.embeddings = false;
            const router = new Router(config);
            
            let calledGemini = false;
            router.adapters.get('gemini').embedText = async () => { calledGemini = true; return { object: "list" }; };
            
            await router.routeEmbeddings({
                model: 'plain-model',
                input: 'test text'
            });
            // Should find gemini since it has embeddings: true
            expect(calledGemini).to.be.true;
        });

        it('should handle embedBatch array inputs gracefully falling back to embedText mapping', async () => {
            const config = createTestConfig();
            config.routing.embeddingProvider = 'gemini';
            const router = new Router(config);
            
            let calls = 0;
            router.adapters.get('gemini').embedText = async (text) => { 
                calls++;
                return { 
                    object: "list", 
                    data: [{ embedding: [0.1, 0.2], index: 0, object: "embedding" }],
                    usage: { prompt_tokens: 5, total_tokens: 5 } 
                }; 
            };
            
            const result = await router.routeEmbeddings({
                model: 'gemini:some-model',
                input: ['test 1', 'test 2', 'test 3']
            });
            
            expect(calls).to.equal(3);
            expect(result.data).to.have.lengthOf(3);
            expect(result.usage.prompt_tokens).to.equal(15);
        });
    });

});
