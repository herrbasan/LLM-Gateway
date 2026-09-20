/**
 * History invariant enforcement (Anthropic-protocol adapters).
 *
 * A client resends its whole history every turn, so a shape the upstream rejects
 * fails on every retry and the session is dead until the client's history
 * changes. These tests pin the pass that keeps such a session alive.
 *
 * The rules under test are the measured ones from scripts/probe-history-shapes.mjs
 * (DeepSeek + Kimi, 2026-09-19) — see the comment on enforceHistoryInvariants.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { enforceHistoryInvariants } from '../src/adapters/anthropic.js';

const text = (t) => ({ type: 'text', text: t });
const call = (id, args = { host: 'a' }) => ({ type: 'tool_use', id, name: 'ping', input: args });
const result = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'pong' });
const assistant = (...content) => ({ role: 'assistant', content });
const user = (...content) => ({ role: 'user', content });

const idsOf = (message) => message.content.filter(b => b.type === 'tool_use').map(b => b.id);
const resultIdsOf = (message) => message.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id);

describe('enforceHistoryInvariants', () => {
    it('leaves a valid history untouched', () => {
        const messages = [
            user(text('ping host a')),
            assistant(call('a'), call('b')),
            user(result('a'), result('b')),
            assistant(text('both answered'))
        ];
        expect(enforceHistoryInvariants(messages)).to.deep.equal(messages);
    });

    it('drops a repeated id inside one turn and keeps the result paired with the survivor', () => {
        const messages = [
            user(text('ping')),
            assistant(call('dup', { host: 'a' }), call('dup', { host: 'a' })),
            user(result('dup'))
        ];

        const out = enforceHistoryInvariants(messages);

        expect(idsOf(out[1])).to.deep.equal(['dup']);
        expect(resultIdsOf(out[2])).to.deep.equal(['dup']);
    });

    it('re-issues an id reused from an earlier turn and rewrites that pair result', () => {
        const messages = [
            user(text('ping')),
            assistant(call('call_0', { turn: 1 })),
            user(result('call_0')),
            user(text('ping again')),
            assistant(call('call_0', { turn: 2 })),
            user(result('call_0'))
        ];

        const out = enforceHistoryInvariants(messages);

        expect(idsOf(out[1]), 'first turn keeps its id').to.deep.equal(['call_0']);
        expect(resultIdsOf(out[2])).to.deep.equal(['call_0']);

        const secondId = idsOf(out[4])[0];
        expect(secondId, 'later turn gets a fresh id').to.not.equal('call_0');
        expect(resultIdsOf(out[5]), 'its result follows the rename').to.deep.equal([secondId]);
    });

    it('drops an orphan result and keeps the rest of that message', () => {
        const messages = [
            user(text('ping')),
            assistant(text('looking it up'), call('known')),
            user(result('ghost'), text('and some prose'))
        ];

        const out = enforceHistoryInvariants(messages);

        expect(out[2].content).to.deep.equal([text('and some prose')]);
        // The call loses its partner too: its result never arrived, only a ghost id did.
        expect(idsOf(out[1])).to.deep.equal([]);
        expect(out[1].content).to.deep.equal([text('looking it up')]);
    });

    it('drops a message that held nothing but an orphan result', () => {
        const messages = [
            user(text('ping')),
            assistant(call('known')),
            user(result('ghost')),
            assistant(text('carry on'))
        ];

        const out = enforceHistoryInvariants(messages);

        expect(out.map(m => m.role)).to.deep.equal(['user', 'assistant']);
        expect(out[1].content).to.deep.equal([text('carry on')]);
    });

    it('drops an unanswered call, and the turn with it when nothing else was in it', () => {
        const messages = [
            user(text('ping')),
            assistant(call('unanswered')),
            user(text('never mind'))
        ];

        const out = enforceHistoryInvariants(messages);

        expect(out.map(m => m.role)).to.deep.equal(['user', 'user']);
        expect(out[1].content).to.deep.equal([text('never mind')]);
    });

    it('keeps an unanswered call turn that still has something to say', () => {
        const messages = [
            user(text('ping')),
            assistant(text('let me check'), call('unanswered')),
            user(text('never mind'))
        ];

        const out = enforceHistoryInvariants(messages);

        expect(out[1].content).to.deep.equal([text('let me check')]);
    });

    it('drops a tool call that ends the history with no result at all', () => {
        const messages = [
            user(text('ping')),
            assistant(call('dangling'))
        ];

        const out = enforceHistoryInvariants(messages);

        expect(out).to.have.length(1);
        expect(out[0].role).to.equal('user');
    });

    it('drops empty text blocks and the message they leave empty', () => {
        const messages = [
            user(text('ping')),
            assistant(text('pong')),
            user(text('')),
            assistant(text('still here'))
        ];

        const out = enforceHistoryInvariants(messages);

        expect(out).to.have.length(3);
        expect(out.map(m => m.role)).to.deep.equal(['user', 'assistant', 'assistant']);
    });

    it('never emits an empty content array', () => {
        const messages = [user(text('hi')), assistant()];
        const out = enforceHistoryInvariants(messages);
        for (const message of out) {
            expect(message.content.length, 'no empty message survives').to.be.greaterThan(0);
        }
    });

    it('refuses a request that has no sendable message left', () => {
        expect(() => enforceHistoryInvariants([user(text('')), assistant()]))
            .to.throw(/no sendable messages/);
    });

    it('keeps non-tool content untouched', () => {
        const messages = [
            user({ type: 'image', source: { type: 'url', url: 'http://x/y.png' } }),
            assistant({ type: 'thinking', thinking: 'hmm' }, text('hi'))
        ];
        const before = JSON.parse(JSON.stringify(messages));
        expect(enforceHistoryInvariants(messages)).to.deep.equal(before);
    });
});
