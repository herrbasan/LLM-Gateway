import { expect } from 'chai';
import { ModelRouter } from '../src/core/model-router.js';

// OpenAI's function-tool spec expects `parameters`. Some clients declare
// argument-less tools with only a name and description — VS Code Copilot's
// `terminal_last_command` and `terminal_selection` do — and some upstreams
// reject the entire request when it is missing (stealth/space-bunny-alpha
// answers 502 provider_unavailable), which looks nothing like a schema problem
// from the client's side.
describe('model-router — tool schema normalization', () => {
    const router = Object.create(ModelRouter.prototype);
    const build = tools => router._buildChatOptions({ tools }, {}, 'test-model').tools;

    it('fills in parameters for a function tool that omits them', () => {
        const out = build([{ type: 'function', function: { name: 'terminal_last_command', description: 'Get the last command.' } }]);
        expect(out[0].function.parameters).to.deep.equal({ type: 'object', properties: {} });
        expect(out[0].function.name).to.equal('terminal_last_command');
        expect(out[0].function.description).to.equal('Get the last command.');
    });

    it('leaves an existing empty parameters object reference-identical', () => {
        const tool = { type: 'function', function: { name: 'testFailure', description: 'x', parameters: { type: 'object', properties: {} } } };
        expect(build([tool])[0]).to.equal(tool);
    });

    it('leaves a full schema reference-identical', () => {
        const tool = {
            type: 'function',
            function: {
                name: 'get_weather',
                description: 'y',
                parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
            }
        };
        expect(build([tool])[0]).to.equal(tool);
    });

    it('returns the original array when nothing needed fixing', () => {
        const tools = [{ type: 'function', function: { name: 'a', parameters: { type: 'object', properties: {} } } }];
        expect(build(tools)).to.equal(tools);
    });

    it('fills in legacy functions entries too', () => {
        const out = router._buildChatOptions({ functions: [{ name: 'legacy' }] }, {}, 'test-model').functions;
        expect(out[0].parameters).to.deep.equal({ type: 'object', properties: {} });
    });

    it('only touches the bare entry in a mixed payload', () => {
        const withParams = { type: 'function', function: { name: 'a', parameters: { type: 'object', properties: { x: { type: 'string' } } } } };
        const bare = { type: 'function', function: { name: 'b' } };
        const out = build([withParams, bare]);
        expect(out[0]).to.equal(withParams);
        expect(out[1].function.parameters).to.deep.equal({ type: 'object', properties: {} });
    });

    it('passes undefined and empty arrays through', () => {
        expect(build(undefined)).to.equal(undefined);
        const empty = [];
        expect(build(empty)).to.equal(empty);
    });
});
