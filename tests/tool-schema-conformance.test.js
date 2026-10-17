/**
 * Tool-schema conformance — real client schemas, through every adapter.
 *
 * Why this file exists: every schema bug that killed a session in 2026 came from a
 * REAL client payload meeting a provider's validator, and none of them was reachable
 * from the tidy synthetic schemas the suite used. VS Code's `ask_user` declares
 * properties literally named `oneOf` and `default`; a sanitiser that treated those as
 * keywords deleted them, left `required` pointing at nothing, and Gemini refused every
 * turn of the conversation.
 *
 * The fixtures in tests/fixtures/client-tools/ are the real shapes (or faithful
 * reductions of them). Each is pushed through each chat adapter, and the outbound body
 * is checked against the invariants providers enforce:
 *
 *   - no tool disappears (containment is for provider refusals, not a silent drop)
 *   - a property NAME is never removed (names are data, not keywords)
 *   - every `required` entry names a property that exists
 *   - keyword stripping still happens where it should
 *
 * Purely additive: this file changes no runtime behaviour.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapters } from '../src/core/adapters.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'client-tools');

const fixtures = fs.readdirSync(FIXTURE_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => ({ name, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) }));

const adapters = createAdapters();
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
    if (realFetch) { globalThis.fetch = realFetch; realFetch = null; }
});

async function sendThrough(adapterName, modelConfig, tools) {
    const sent = captureUpstream();
    try {
        await adapters.get(adapterName).chatComplete(modelConfig, {
            messages: [{ role: 'user', content: 'hi' }],
            tools,
            maxTokens: 32,
            stream: false
        });
    } catch { /* the stub rejects after the body is captured */ }
    return sent[0];
}

// Distinct adapterModel values from every other test file: containment remembers a
// refusal per adapter|model for the process, and sharing a key across suites would let
// one file's simulated refusal leak into another's assertions.
const MODELS = {
    openai: {
        type: 'chat', adapter: 'openai', adapterModel: 'm-conformance',
        endpoint: 'https://upstream.invalid/v1', apiKey: 'k',
        capabilities: { contextWindow: 100000, maxOutputTokens: 1000 }
    },
    anthropic: {
        type: 'chat', adapter: 'anthropic', adapterModel: 'deepseek-conformance',
        endpoint: 'https://upstream.invalid', apiKey: 'k',
        capabilities: { contextWindow: 100000, maxOutputTokens: 1000 }
    },
    gemini: {
        type: 'chat', adapter: 'gemini', adapterModel: 'gemini-conformance',
        endpoint: 'https://upstream.invalid/v1beta', apiKey: 'k',
        capabilities: { contextWindow: 1000000, maxOutputTokens: 100000 }
    }
};

// Same lookup for all three shapes: OpenAI nests under function, Anthropic and the
// Gemini Interactions API put name + schema at the top level.
const nameOf = (tool) => tool?.function?.name ?? tool?.name;
const parametersOf = (tool) => tool?.function?.parameters ?? tool?.parameters ?? tool?.input_schema;

/**
 * Property names survive at every depth. A name is data: `oneOf`, `default`, `format`
 * and `if` are all legal property names, and deleting one also invalidates `required`.
 */
function expectNamesPreserved(expected, actual, where) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return;
    if (!actual || typeof actual !== 'object') {
        expect.fail(`${where} disappeared from the outbound schema`);
    }
    if (expected.properties && typeof expected.properties === 'object') {
        expect(actual.properties, `${where}.properties disappeared`).to.be.an('object');
        expect(Object.keys(actual.properties), `${where}.properties names`)
            .to.have.members(Object.keys(expected.properties));
        for (const [name, sub] of Object.entries(expected.properties)) {
            expectNamesPreserved(sub, actual.properties[name], `${where}.properties.${name}`);
        }
    }
    if (expected.additionalProperties && typeof expected.additionalProperties === 'object') {
        expectNamesPreserved(expected.additionalProperties, actual.additionalProperties, `${where}.additionalProperties`);
    }
    if (expected.items && typeof expected.items === 'object' && !Array.isArray(expected.items)) {
        expectNamesPreserved(expected.items, actual.items, `${where}.items`);
    }
    // `anyOf` survives Gemini; a stripped keyword (oneOf/allOf) simply has no counterpart.
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (!Array.isArray(expected[key])) continue;
        if (!Array.isArray(actual[key])) continue;
        expected[key].forEach((sub, i) => expectNamesPreserved(sub, actual[key][i], `${where}.${key}[${i}]`));
    }
}

/** Every `required` entry must name a property that exists — Gemini refuses otherwise. */
function expectRequiredResolvable(schema, where) {
    if (!schema || typeof schema !== 'object') return;
    if (Array.isArray(schema.required)) {
        const declared = Object.keys(schema.properties ?? {});
        for (const entry of schema.required) {
            expect(declared, `${where}: required "${entry}" must exist in properties`).to.include(entry);
        }
    }
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
        expectRequiredResolvable(sub, `${where}.properties.${name}`);
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        expectRequiredResolvable(schema.additionalProperties, `${where}.additionalProperties`);
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
        expectRequiredResolvable(schema.items, `${where}.items`);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(schema[key])) schema[key].forEach((sub, i) => expectRequiredResolvable(sub, `${where}.${key}[${i}]`));
    }
}

describe('tool-schema conformance — real client payloads', () => {
    it('has fixtures to run (a missing corpus would make this suite vacuous)', () => {
        expect(fixtures.length, 'add real schemas to tests/fixtures/client-tools').to.be.greaterThan(0);
    });

    for (const fixture of fixtures) {
        for (const adapterName of Object.keys(MODELS)) {
            it(`${fixture.name} → ${adapterName}`, async () => {
                const body = await sendThrough(adapterName, MODELS[adapterName], fixture.tools);
                const outbound = body.tools;

                expect(outbound, 'the tools survive at all').to.be.an('array');
                expect(outbound.map(nameOf), 'no tool is silently dropped')
                    .to.have.members(fixture.tools.map(t => t.function.name));

                for (const tool of fixture.tools) {
                    const declared = tool.function.name;
                    const sent = outbound.find(t => nameOf(t) === declared);
                    expect(sent, `${declared} is offered`).to.be.ok;

                    const expected = tool.function.parameters;
                    const actual = parametersOf(sent);

                    expectNamesPreserved(expected, actual, `${adapterName}/${declared}`);
                    expectRequiredResolvable(actual, `${adapterName}/${declared}`);
                }
            });
        }
    }

    it('gemini still strips meta-annotations (the sanitiser still does its job)', async () => {
        const fixture = fixtures.find(f => f.name === 'annotated-schema.json');
        const body = await sendThrough('gemini', MODELS.gemini, fixture.tools);
        const schema = parametersOf(body.tools[0]);

        expect(schema, 'a top-level $ key is meta-schema').to.not.have.property('$schema');
        expect(schema.properties.path, 'format is stripped at a keyword position').to.not.have.property('format');
        expect(schema.properties.path, 'markdownDescription too').to.not.have.property('markdownDescription');
        expect(schema.properties.options.properties, 'but a property NAMED format is kept')
            .to.have.property('format');
    });

    it('openai and anthropic pass schemas through untouched', async () => {
        const fixture = fixtures.find(f => f.name === 'vscode-ask-user.json');
        const expected = fixture.tools[0].function.parameters;

        for (const adapterName of ['openai', 'anthropic']) {
            const body = await sendThrough(adapterName, MODELS[adapterName], fixture.tools);
            expect(parametersOf(body.tools[0]), `${adapterName} must not rewrite a valid schema`)
                .to.deep.equal(expected);
        }
    });
});

describe('tool-schema capture — corpus building', () => {
    it('writes the tools array and nothing else, when enabled', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-capture-'));
        process.env.CAPTURE_TOOLS_DIR = dir;
        try {
            // Fresh module instance: the target directory is read at load time.
            const { captureToolSchemas } = await import(`../src/utils/tool-capture.js?capture=${Date.now()}`);
            captureToolSchemas('capture-probe', [
                { type: 'function', function: { name: 't', parameters: { type: 'object' } } }
            ]);

            const files = fs.readdirSync(dir);
            expect(files, 'one set captured').to.have.length(1);

            const written = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
            expect(written.tools[0].function.name).to.equal('t');
            // Messages carry user words; the corpus must never hold them.
            expect(JSON.stringify(written)).to.not.include('"messages"');
        } finally {
            delete process.env.CAPTURE_TOOLS_DIR;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does nothing when the directory is not configured', async () => {
        const { captureToolSchemas } = await import(`../src/utils/tool-capture.js?idle=${Date.now()}`);
        expect(() => captureToolSchemas('m', [{ type: 'function', function: { name: 't' } }])).to.not.throw();
    });
});
