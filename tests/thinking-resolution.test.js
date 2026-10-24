// Thinking resolution: how a client's request becomes the one control an
// adapter may send. The rule under test is fail-loud-prevention rather than
// tolerance: a model that declares its effort levels and omits 'none' cannot
// switch thinking off, so "off" must never reach the wire as
// `thinking: { type: "disabled" }` (Kimi K3.1 Pro answers 400, 2026-10-23).
//
// _resolveThinking is pure — it reads only its arguments — so it is exercised
// on the prototype rather than through a fully constructed router.

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ModelRouter } from '../src/core/model-router.js';

const resolve = (request, modelConfig) =>
    ModelRouter.prototype._resolveThinking.call({}, request, modelConfig, 'test-model');

const k31 = () => ({ capabilities: { thinkingLevels: ['low', 'high', 'max'] }, reasoning_effort: 'low' });
const k3 = () => ({ capabilities: { thinkingLevels: ['none', 'low', 'high', 'max'] } });

describe('_resolveThinking — thinking-off on a model that cannot disable it', () => {

    it('boolean off on a model without a none level becomes its lowest level', () => {
        const thinking = resolve({ enable_thinking: false }, { capabilities: { thinkingLevels: ['low', 'high', 'max'] } });
        expect(thinking.reasoning_effort).to.equal('low');
        expect(thinking.enable_thinking).to.equal(true);
    });

    it('effort none on a model without a none level rounds up to its lowest level', () => {
        const thinking = resolve({ enable_thinking: false, reasoning_effort: 'none' }, k31());
        expect(thinking.reasoning_effort).to.equal('low');
        expect(thinking.enable_thinking).to.equal(true);
    });

    it('declared none level still switches thinking off', () => {
        const thinking = resolve({ enable_thinking: false }, k3());
        expect(thinking.reasoning_effort).to.equal(undefined);
        expect(thinking.enable_thinking).to.equal(false);

        const byEffort = resolve({ reasoning_effort: 'none' }, k3());
        expect(byEffort.reasoning_effort).to.equal('none');
        expect(byEffort.enable_thinking).to.equal(false);
    });

    it('model with no declared levels keeps the boolean form untouched', () => {
        const thinking = resolve({ enable_thinking: false }, { capabilities: {} });
        expect(thinking.reasoning_effort).to.equal(undefined);
        expect(thinking.enable_thinking).to.equal(false);
    });

    it('a config-level effort default survives a client thinking-off request', () => {
        const thinking = resolve({ enable_thinking: false }, k31());
        expect(thinking.reasoning_effort).to.equal('low');
        expect(thinking.enable_thinking).to.equal(true);
    });

    it('an explicit effort is passed through and keeps thinking on', () => {
        const thinking = resolve({ reasoning_effort: 'high' }, k31());
        expect(thinking.reasoning_effort).to.equal('high');
        expect(thinking.enable_thinking).to.equal(true);
    });

    it('an undeclared effort maps to the nearest declared level', () => {
        const thinking = resolve({ reasoning_effort: 'xhigh' }, k31());
        expect(thinking.reasoning_effort).to.equal('max');
    });
});
