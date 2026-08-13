/**
 * Gemini Interactions API adapter tests — live against Google.
 * Verifies the adapter's stateless mapping onto the Interactions API.
 */
import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import { createAdapters } from '../src/core/adapters.js';
import { loadConfig } from '../src/config.js';

function hasCredentials(modelConfig) {
    if (!modelConfig?.apiKey) return false;
    if (modelConfig.apiKey.includes('${')) return false;
    if (modelConfig.apiKey.toLowerCase().includes('test')) return false;
    return true;
}

describe('Gemini Interactions Adapter - Live', function () {
    this.timeout(60000);

    let adapters;
    let geminiModel;

    before(async function () {
        const config = await loadConfig();
        adapters = createAdapters();
        geminiModel = Object.values(config.models || {}).find(
            m => m.adapter === 'gemini' && m.type === 'chat'
        );
        if (!geminiModel || !hasCredentials(geminiModel)) {
            console.log('[SKIP] Gemini credentials not available');
            this.skip();
        }
    });

    const weatherTool = {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Gets the weather for a location',
            parameters: {
                type: 'object',
                properties: { location: { type: 'string' } },
                required: ['location']
            }
        }
    };

    it('should complete a simple chat', async () => {
        const adapter = adapters.get('gemini');
        const result = await adapter.chatComplete(geminiModel, {
            messages: [{ role: 'user', content: 'Say exactly: INTERACTIONS_OK' }]
        });

        expect(result.object).to.equal('chat.completion');
        expect(result.choices[0].message.content).to.include('INTERACTIONS_OK');
        expect(result.choices[0].finish_reason).to.equal('stop');
        expect(result.usage.total_tokens).to.be.a('number');
    });

    it('should complete a multi-turn conversation statelessly', async () => {
        const adapter = adapters.get('gemini');
        const result = await adapter.chatComplete(geminiModel, {
            messages: [
                { role: 'user', content: 'My dog is named Rex.' },
                { role: 'assistant', content: 'Got it — Rex the dog.' },
                { role: 'user', content: "What is my dog's name?" }
            ]
        });
        expect(result.choices[0].message.content).to.match(/Rex/i);
    });

    it('should return a function call for a tool request', async () => {
        const adapter = adapters.get('gemini');
        const result = await adapter.chatComplete(geminiModel, {
            messages: [{ role: 'user', content: "What's the weather in Boston?" }],
            tools: [weatherTool]
        });

        expect(result.choices[0].finish_reason).to.equal('tool_calls');
        const toolCall = result.choices[0].message.tool_calls[0];
        expect(toolCall).to.be.an('object');
        expect(toolCall.id).to.match(/^call_/);
        expect(toolCall.function.name).to.equal('get_weather');
    });

    it('should complete a full tool round-trip', async () => {
        const adapter = adapters.get('gemini');

        // Turn 1: ask, get the function call (adapter caches the thought signature)
        const turn1 = await adapter.chatComplete(geminiModel, {
            messages: [{ role: 'user', content: "What's the weather in Boston?" }],
            tools: [weatherTool]
        });
        const toolCall = turn1.choices[0].message.tool_calls[0];
        expect(toolCall).to.be.an('object');

        // Turn 2: replay full history with the tool result
        const result = await adapter.chatComplete(geminiModel, {
            messages: [
                { role: 'user', content: "What's the weather in Boston?" },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: toolCall.id,
                        type: 'function',
                        function: {
                            name: toolCall.function.name,
                            arguments: toolCall.function.arguments
                        }
                    }]
                },
                { role: 'tool', tool_call_id: toolCall.id, name: 'get_weather', content: '52F and rain' }
            ],
            tools: [weatherTool]
        });

        expect(result.choices[0].finish_reason).to.equal('stop');
        expect(result.choices[0].message.content).to.match(/52|rain/i);
    });

    it('should stream text', async () => {
        const adapter = adapters.get('gemini');
        const generator = adapter.streamComplete(geminiModel, {
            messages: [{ role: 'user', content: 'Count from 1 to 3.' }]
        });

        let content = '';
        let sawFinish = false;
        for await (const chunk of generator) {
            content += chunk.choices?.[0]?.delta?.content || '';
            if (chunk.choices?.[0]?.finish_reason) sawFinish = true;
        }

        expect(content.length).to.be.greaterThan(0);
        expect(sawFinish).to.be.true;
    });

    it('should stream a function call', async () => {
        const adapter = adapters.get('gemini');
        const generator = adapter.streamComplete(geminiModel, {
            messages: [{ role: 'user', content: "What's the weather in Boston?" }],
            tools: [weatherTool]
        });

        const toolCalls = [];
        let sawToolFinish = false;
        for await (const chunk of generator) {
            const choice = chunk.choices?.[0];
            const tcs = choice?.delta?.tool_calls;
            if (tcs) {
                for (const tc of tcs) {
                    toolCalls[tc.index] = toolCalls[tc.index] || { id: null, name: '', arguments: '' };
                    if (tc.id) toolCalls[tc.index].id = tc.id;
                    if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
                    if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
                }
            }
            if (choice?.finish_reason === 'tool_calls') sawToolFinish = true;
        }

        expect(toolCalls.length).to.be.greaterThan(0);
        expect(toolCalls[0].name).to.equal('get_weather');
        expect(toolCalls[0].id).to.match(/^call_/);
        expect(sawToolFinish).to.be.true;
    });
});
