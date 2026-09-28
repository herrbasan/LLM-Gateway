import { expect } from 'chai';
import { normalizeResponse, normalizeStreamChunk } from '../src/utils/response-normalizer.js';

// OpenRouter reports reasoning in a `reasoning` field (and the full trace in
// `reasoning_details[]`) instead of OpenAI's `reasoning_content`. Unmapped, a
// reasoning-only turn looks like a content-free stream and reaches the client
// as "Upstream returned no content" (502 ZERO_CONTENT), and clients that read
// `reasoning_content` (VS Code Copilot) never see the thinking at all.
describe('response-normalizer — OpenRouter reasoning alias', () => {
    const deltaOf = chunk => normalizeStreamChunk(chunk).choices[0].delta;
    const messageOf = response => normalizeResponse(response).choices[0].message;

    it('maps a streaming delta.reasoning onto reasoning_content', () => {
        const delta = deltaOf({ choices: [{ delta: { reasoning: 'step one' } }] });
        expect(delta.reasoning_content).to.equal('step one');
    });

    it('injects an empty content alongside reasoning', () => {
        const delta = deltaOf({ choices: [{ delta: { reasoning: 'step one' } }] });
        expect(delta.content).to.equal('');
    });

    it('joins reasoning_details[].text when the alias is absent', () => {
        const delta = deltaOf({
            choices: [{
                delta: {
                    reasoning_details: [
                        { type: 'reasoning.text', text: 'a' },
                        { type: 'reasoning.text', text: 'b' }
                    ]
                }
            }]
        });
        expect(delta.reasoning_content).to.equal('a\nb');
    });

    it('never overwrites a native reasoning_content', () => {
        const delta = deltaOf({ choices: [{ delta: { reasoning_content: 'native', reasoning: 'alias' } }] });
        expect(delta.reasoning_content).to.equal('native');
    });

    it('leaves a content-only delta untouched', () => {
        const delta = deltaOf({ choices: [{ delta: { content: 'hello' } }] });
        expect(delta.reasoning_content).to.equal(undefined);
        expect(delta.content).to.equal('hello');
    });

    it('maps a non-streaming message.reasoning onto reasoning_content', () => {
        const message = messageOf({ choices: [{ message: { role: 'assistant', content: '', reasoning: 'because' } }] });
        expect(message.reasoning_content).to.equal('because');
    });

    it('ignores a non-string reasoning (Responses API shape)', () => {
        const message = messageOf({
            choices: [{ message: { role: 'assistant', content: 'x', reasoning: { effort: 'high', summary: null } } }]
        });
        expect(message.reasoning_content).to.equal(undefined);
    });
});
