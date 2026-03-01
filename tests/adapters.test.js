import { expect } from 'chai';
import { createAdapters } from '../src/adapters/index.js';
import { createLmStudioAdapter } from '../src/adapters/lmstudio.js';
import { createOllamaAdapter } from '../src/adapters/ollama.js';
import { createGeminiAdapter } from '../src/adapters/gemini.js';
import { createOpenAIAdapter } from '../src/adapters/openai.js';

describe('Provider Adapters', () => {

    describe('Factory & Registry Initialization', () => {
         it('should instantiate only valid adapters mapped by config', () => {
             const mockConfig = {
                 validLM: { type: 'lmstudio', endpoint: 'http://foo' },
                 validOllama: { type: 'ollama' },
                 missingProvider: { endpoint: 'http://foo' },
                 invalidProvider: { type: 'unknown_magic_type' }
             };

             const registry = createAdapters(mockConfig);
             
             // Registry must have correctly loaded 2 adapters
             expect(registry.size).to.equal(2);
             expect(registry.has('validLM')).to.be.true;
             expect(registry.has('validOllama')).to.be.true;
         });
    });

    describe('Adapter Standardization Contracts', () => {
         const lmAdapter = createLmStudioAdapter({ type: 'lmstudio', endpoint: 'http://mock', model: 'test' });
         const ollamaAdapter = createOllamaAdapter({ type: 'ollama', endpoint: 'http://mock', model: 'test' });
         const geminiAdapter = createGeminiAdapter({ type: 'gemini', apiKey: 'test_key', model: 'test' });
         const openaiAdapter = createOpenAIAdapter({ type: 'openai', apiKey: 'test_key', model: 'test' });

         const verifyAdapterShape = adapter => {
             expect(adapter).to.have.property('name');
             expect(adapter).to.have.property('capabilities');
             expect(adapter.predict).to.be.a('function');
             expect(adapter.streamComplete).to.be.a('function');
             expect(adapter.embedText).to.be.a('function');
             expect(adapter.resolveModel).to.be.a('function');
             expect(adapter.listModels).to.be.a('function');
             expect(adapter.getContextWindow).to.be.a('function');
         };

         it('LM Studio obeys the interface contract', () => verifyAdapterShape(lmAdapter));
         it('Ollama obeys the interface contract', () => verifyAdapterShape(ollamaAdapter));
         it('Gemini obeys the interface contract', () => verifyAdapterShape(geminiAdapter));
         it('OpenAI obeys the interface contract', () => verifyAdapterShape(openaiAdapter));

         it('Adapters properly resolve the "auto" model identifier', async () => {
              expect(await lmAdapter.resolveModel('auto')).to.equal('test');
              expect(await ollamaAdapter.resolveModel('auto')).to.equal('test');
              expect(await geminiAdapter.resolveModel('auto')).to.equal('test');
              expect(await openaiAdapter.resolveModel('auto')).to.equal('test');
         });
    });

});
