import { expect } from 'chai';
import dotenv from 'dotenv';
import { createGeminiAdapter } from '../src/adapters/gemini.js';

// Load .env variables
dotenv.config();

describe('Gemini Adapter Live Workflows', function() {
    // These tests interact with the real Gemini API, which can take time
    this.timeout(30000);

    let adapter;

    before(function() {
        if (!process.env.GEMINI_API_KEY) {
            console.warn('⚠️ Skipping Gemini live tests: GEMINI_API_KEY not set in .env');
            this.skip();
        }
        
        adapter = createGeminiAdapter({
            type: 'gemini',
            apiKey: process.env.GEMINI_API_KEY,
            model: 'gemini-2.0-flash' // Standard model for tests
        });
    });

    it('should calculate tokens accurately using the native endpoint', async () => {
        const text = 'Hello world, this is a test to count tokens correctly.';
        const tokens = await adapter.countTokens(text);
        
        expect(tokens).to.be.a('number');
        expect(tokens).to.be.greaterThan(0);
        expect(tokens).to.be.lessThan(50); // A sanity check
    });

    it('should generate a standard completion (predict) preserving standard OpenAI format', async () => {
        const res = await adapter.predict({
            messages: [{ role: 'user', content: 'Repeat exactly this word: "BANANA"' }]
        });
        
        expect(res).to.have.property('id').that.includes('gemini');
        expect(res).to.have.property('object', 'chat.completion');
        expect(res).to.have.property('provider', 'gemini');
        expect(res.choices[0].message.role).to.equal('assistant');
        expect(res.choices[0].message.content).to.include('BANANA');
    });

    it('should correctly format and enforce structured json output', async () => {
        // Note: Gemini v1beta REST API schema requires upper-case datatypes (e.g. "OBJECT", "STRING") 
        // to strictly abide by its OpenAPI constraints. 
        const schema = {
            type: "OBJECT",
            properties: {
                fruit: { type: "STRING" },
                color: { type: "STRING" }
            },
            required: ["fruit", "color"]
        };

        const res = await adapter.predict({
            messages: [{ role: 'user', content: 'Describe a typical apple in JSON.' }],
            schema: schema
        });

        const content = res.choices[0].message.content;
        
        // Ensure it parses successfully to verify deterministic JSON output
        const parsed = JSON.parse(content);
        expect(parsed).to.have.property('fruit');
        expect(parsed).to.have.property('color');
    });

    it('should successfully map system instructions transparently', async () => {
        const res = await adapter.predict({
            messages: [
                { role: 'system', content: 'You are a pirate. You must reply to everything by only saying "Arrr!"' },
                { role: 'user', content: 'Hello there.' }
            ]
        });
        
        expect(res.choices[0].message.content).to.match(/Arrr/i);
    });

    it('should stream tokens correctly (streamComplete) acting like OpenAI SSE chunks', async () => {
        const generator = adapter.streamComplete({
            messages: [{ role: 'user', content: 'Count from 1 to 5 with numbers separated by commas.' }]
        });

        let output = '';
        let chunkCount = 0;
        
        for await (const chunk of generator) {
            expect(chunk).to.have.property('id');
            expect(chunk).to.have.property('object', 'chat.completion.chunk');
            expect(chunk.choices[0]).to.have.property('delta');
            
            output += chunk.choices[0].delta.content || '';
            chunkCount++;
        }

        expect(chunkCount).to.be.greaterThan(0);
        expect(output).to.include('1');
        expect(output).to.include('5');
    });

    it('should cleanly batch arrays for text embeddings', async () => {
        const texts = [
            'This is the first string.',
            'Here is the second string.'
        ];
        
        const res = await adapter.embedText(texts);
        
        expect(res).to.have.property('object', 'list');
        expect(res).to.have.property('model').that.includes('embedding');
        expect(res.data).to.be.an('array').with.lengthOf(2);
        
        // Verify shapes
        expect(res.data[0]).to.have.property('object', 'embedding');
        expect(res.data[0].embedding).to.be.an('array').with.lengthOf.greaterThan(100);
        expect(res.data[0].index).to.equal(0);
        
        expect(res.data[1].embedding).to.be.an('array').with.lengthOf.greaterThan(100);
        expect(res.data[1].index).to.equal(1);
    });
});
