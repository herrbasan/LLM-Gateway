import { expect } from 'chai';
import { applyMistralThinkingHistory } from '../src/adapters/openai.js';
import { normalizeResponse, normalizeStreamChunk } from '../src/utils/response-normalizer.js';

const think = text => ({ type: 'thinking', thinking: [{ type: 'text', text }] });
const text = value => ({ type: 'text', text: value });

describe('Mistral content chunks', () => {
    it('normalizes a non-streaming thinking/text response', () => {
        const response = normalizeResponse({
            choices: [{ message: { role: 'assistant', content: [think('reason'), text('answer')] } }]
        });
        const message = response.choices[0].message;
        expect(message.content).to.equal('answer');
        expect(message.reasoning_content).to.equal('reason');
    });

    it('normalizes streaming thinking and transition deltas', () => {
        const thinking = normalizeStreamChunk({ choices: [{ delta: { content: [think('reason')] } }] });
        expect(thinking.choices[0].delta.content).to.equal('');
        expect(thinking.choices[0].delta.reasoning_content).to.equal('reason');

        const transition = normalizeStreamChunk({ choices: [{ delta: { content: [think('done'), text('answer')] } }] });
        expect(transition.choices[0].delta.content).to.equal('answer');
        expect(transition.choices[0].delta.reasoning_content).to.equal('done');
    });

    it('leaves richer content arrays intact', () => {
        const content = [text('answer'), { type: 'reference', reference_ids: [1] }];
        const response = normalizeResponse({ choices: [{ message: { role: 'assistant', content } }] });
        expect(response.choices[0].message.content).to.deep.equal(content);
        expect(response.choices[0].message.reasoning_content).to.equal(undefined);
    });

    it('rebuilds ThinkChunk history and removes fields Mistral rejects', () => {
        const payload = {
            messages: [{
                role: 'assistant',
                content: 'answer',
                reasoning_content: 'reason',
                thinking_signature: 'not-supported',
                refusal: null,
                annotations: [],
                function_call: null,
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'f', arguments: '{}' } }]
            }]
        };
        applyMistralThinkingHistory(payload, { thinkingChunks: 'mistral' });
        const message = payload.messages[0];
        expect(message.content).to.deep.equal([think('reason'), text('answer')]);
        expect(message).to.not.have.property('reasoning_content');
        expect(message).to.not.have.property('thinking_signature');
        expect(message).to.not.have.property('refusal');
        expect(message).to.not.have.property('annotations');
        expect(message).to.not.have.property('function_call');
        expect(message.tool_calls).to.have.length(1);
    });

    it('does not duplicate an existing ThinkChunk or invent one for empty reasoning', () => {
        const payload = {
            messages: [
                { role: 'assistant', content: [think('original'), text('answer')], reasoning_content: 'duplicate' },
                { role: 'assistant', content: 'plain', reasoning_content: '', refusal: null, annotations: [], function_call: null },
                { role: 'assistant', content: 'also plain', reasoning_content: null }
            ]
        };
        applyMistralThinkingHistory(payload, { thinkingChunks: 'mistral' });
        expect(payload.messages[0].content).to.deep.equal([think('original'), text('answer')]);
        expect(payload.messages[0]).to.not.have.property('reasoning_content');
        expect(payload.messages[1].content).to.equal('plain');
        expect(payload.messages[1]).to.not.have.property('reasoning_content');
        expect(payload.messages[2].content).to.equal('also plain');
        expect(payload.messages[2]).to.not.have.property('reasoning_content');
    });
});
