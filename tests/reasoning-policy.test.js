// Unit tests for applyReasoningHistoryPolicy (openai adapter).
// Policy facts verified 2026-08-29 — see storage documentation/LLM APIs/provider_*.md
// and LLM-Gateway-Chat docs/plan-context-cost-and-reporting.md §3.

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { applyReasoningHistoryPolicy } from '../src/adapters/openai.js';

const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }];

function history() {
    return [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'let me think', reasoning_content: 'deep thoughts', thinking_signature: 'sig1',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'result' },
        { role: 'assistant', content: 'answer', reasoning_content: 'more thoughts' }
    ];
}

describe('applyReasoningHistoryPolicy', () => {

    it('unset policy: keeps history untouched (cache-safe default)', () => {
        const payload = { messages: history(), tools };
        applyReasoningHistoryPolicy(payload, {});
        expect(payload.messages[1].reasoning_content).to.equal('deep thoughts');
        expect(payload.messages[1].thinking_signature).to.equal('sig1');
    });

    it("policy 'ignored' (OpenAI): strips reasoning_content + thinking_signature everywhere", () => {
        const payload = { messages: history(), tools };
        applyReasoningHistoryPolicy(payload, { priorReasoning: 'ignored' });
        expect(payload.messages[1]).to.not.have.property('reasoning_content');
        expect(payload.messages[1]).to.not.have.property('thinking_signature');
        expect(payload.messages[3]).to.not.have.property('reasoning_content');
        expect(payload.messages[1].tool_calls).to.have.length(1);
    });

    it("policy 'required' (xAI/Kimi): keeps and injects empty reasoning_content on tool-call messages missing it", () => {
        const msgs = history();
        delete msgs[1].reasoning_content;
        const payload = { messages: msgs, tools };
        applyReasoningHistoryPolicy(payload, { priorReasoning: 'required' });
        expect(payload.messages[1].reasoning_content).to.equal('');
        expect(payload.messages[3].reasoning_content).to.equal('more thoughts');
    });

    it("policy 'required-with-tools' + tools advertised (DeepSeek tool chain): keeps, injects empty when missing", () => {
        const msgs = history();
        delete msgs[1].reasoning_content;
        const payload = { messages: msgs, tools };
        applyReasoningHistoryPolicy(payload, { priorReasoning: 'required-with-tools' });
        expect(payload.messages[1].reasoning_content).to.equal('');
        expect(payload.messages[3].reasoning_content).to.equal('more thoughts');
    });

    it("policy 'required-with-tools' + NO tools (DeepSeek plain chat): strips", () => {
        const payload = { messages: history() };
        applyReasoningHistoryPolicy(payload, { priorReasoning: 'required-with-tools' });
        expect(payload.messages[1]).to.not.have.property('reasoning_content');
        expect(payload.messages[3]).to.not.have.property('reasoning_content');
    });

    it("legacy reasoningContent === true still injects (backward compat with live configs)", () => {
        const msgs = history();
        delete msgs[1].reasoning_content;
        const payload = { messages: msgs, tools };
        applyReasoningHistoryPolicy(payload, { reasoningContent: true });
        expect(payload.messages[1].reasoning_content).to.equal('');
    });

    it('non-array messages: no-op, no throw', () => {
        const payload = { messages: undefined };
        expect(() => applyReasoningHistoryPolicy(payload, { priorReasoning: 'ignored' })).to.not.throw();
    });

    it("policy 'required' + clearThinkingSupport (z.AI GLM): sends thinking.clear_thinking=false", () => {
        const payload = { messages: history(), tools };
        applyReasoningHistoryPolicy(payload, { priorReasoning: 'required', clearThinkingSupport: true });
        expect(payload.thinking).to.deep.equal({ clear_thinking: false });
        expect(payload.messages[1].reasoning_content).to.equal('deep thoughts');
    });

    it("policy 'required' WITHOUT clearThinkingSupport: no thinking field added", () => {
        const payload = { messages: history(), tools };
        applyReasoningHistoryPolicy(payload, { priorReasoning: 'required' });
        expect(payload).to.not.have.property('thinking');
    });
});
