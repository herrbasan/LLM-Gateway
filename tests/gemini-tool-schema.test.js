/**
 * Gemini tool-schema sanitising — names must survive keyword stripping.
 *
 * The sanitiser walks a JSON Schema and deletes unsupported keywords by name. Inside
 * a `properties` map the keys are property NAMES, so a tool may legitimately declare
 * a property called `oneOf`, `default`, `format` or `if`. VS Code's own `ask_user`
 * does exactly that, and deleting those names left `required` pointing at a property
 * that no longer existed:
 *
 *   Invalid schema in function tool 'ask_user' parameters: specifies required field
 *   'oneOf' which is not defined in properties.
 *
 * Every Gemini turn carrying tools died, and the client resends its tools on every
 * turn — so this was a dead session, not a failed request. The fixtures below are the
 * real shape for that reason: a tidy synthetic schema is what let this through.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createGeminiAdapter } from '../src/adapters/gemini.js';

const MODEL = {
    type: 'chat',
    adapter: 'gemini',
    adapterModel: 'gemini-4-argon',
    endpoint: 'https://upstream.invalid/v1beta',
    apiKey: 'test-key',
    capabilities: { contextWindow: 1048576, maxOutputTokens: 65536 }
};

const adapter = createGeminiAdapter();
let realFetch = null;

function captureUpstream() {
    const sent = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ error: { message: 'captured' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' }
        });
    };
    return sent;
}

afterEach(() => {
    if (realFetch) {
        globalThis.fetch = realFetch;
        realFetch = null;
    }
});

async function sendTools(parameters) {
    const sent = captureUpstream();
    try {
        await adapter.chatComplete(MODEL, {
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: 't', description: 'd', parameters } }],
            maxTokens: 32,
            stream: false
        });
    } catch { /* the stub rejects after the body is captured */ }
    return sent[0].tools[0];
}

describe('Gemini adapter — tool schema sanitising', () => {
    it('keeps properties whose NAMES match schema keywords', async () => {
        // The 2026-10-17 failure: properties named oneOf and default.
        const decl = await sendTools({
            type: 'object',
            properties: {
                oneOf: { type: 'array', items: { type: 'object' } },
                default: { type: 'string' },
                format: { type: 'string' },
                if: { type: 'string' }
            },
            required: ['oneOf', 'default']
        });

        const names = Object.keys(decl.parameters.properties);
        expect(names, 'names are data, not keywords').to.include.members(['oneOf', 'default', 'format', 'if']);
    });

    it('keeps every required name that the schema declares', async () => {
        const decl = await sendTools({
            type: 'object',
            properties: {
                message: { type: 'string' },
                requestedSchema: { type: 'object', properties: { properties: { type: 'object' } } }
            },
            required: ['message', 'requestedSchema']
        });

        expect(decl.parameters.required).to.deep.equal(['message', 'requestedSchema']);
    });

    it('still strips unsupported keywords at schema positions', async () => {
        // The original intent of the sanitiser, which must not be lost.
        const decl = await sendTools({
            type: 'object',
            properties: {
                when: { type: 'string', format: 'date-time', default: 'now', '$comment': 'x' }
            },
            required: ['when'],
            $schema: 'http://json-schema.org/draft-07/schema#'
        });

        const when = decl.parameters.properties.when;
        expect(when.type).to.equal('string');
        expect(when, 'format/default/$comment are keywords here').to.not.have.any.keys('format', 'default', '$comment');
        expect(decl.parameters, 'a top-level $ key is meta-schema').to.not.have.property('$schema');
    });

    it('prunes a required name that names nothing, rather than sending a 400', async () => {
        // A genuinely inconsistent client schema. Gemini refuses the whole request
        // over it, and the client resends it every turn, so it is repaired.
        const decl = await sendTools({
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a', 'ghost']
        });

        expect(decl.parameters.required).to.deep.equal(['a']);
    });

    it('drops required entirely when it names nothing at all', async () => {
        const decl = await sendTools({
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['ghost']
        });

        expect(decl.parameters).to.not.have.property('required');
    });

    it('leaves nested property maps intact at depth', async () => {
        // The ask_user shape nests one level deeper: a form-field definition inside
        // an additionalProperties schema.
        const decl = await sendTools({
            type: 'object',
            properties: {
                requestedSchema: {
                    type: 'object',
                    properties: {
                        properties: {
                            type: 'object',
                            additionalProperties: {
                                type: 'object',
                                properties: {
                                    type: { type: 'string' },
                                    oneOf: { type: 'array', items: { type: 'object' } },
                                    default: { type: 'string' }
                                },
                                required: ['type', 'oneOf']
                            }
                        }
                    },
                    required: ['properties']
                }
            },
            required: ['requestedSchema']
        });

        const nested = decl.parameters.properties.requestedSchema
            .properties.properties.additionalProperties;
        expect(Object.keys(nested.properties)).to.include.members(['oneOf', 'default']);
        expect(nested.required).to.deep.equal(['type', 'oneOf']);
    });
});
