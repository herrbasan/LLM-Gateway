/**
 * Probe: does Gemini accept the tool schemas real clients actually send?
 *
 * The path under test is VS Code's own `ask_user` definition, whose parameters carry
 * properties NAMED `oneOf` and `default` (union variants and option defaults). The
 * sanitiser used to delete those by name and leave `required` pointing at them:
 *
 *   Invalid schema in function tool 'ask_user' parameters: specifies required field
 *   'oneOf' which is not defined in properties.
 *
 * Three questions, in order of what would bite next:
 *   1. property NAMES that collide with keywords  — the 2026-10-17 failure
 *   2. `anyOf` (a real JSON-Schema keyword, not stripped) — does Gemini take it?
 *   3. `const` — same question
 *
 * Run: node scripts/probe-gemini-tool-schema.mjs [modelId]
 */
import fs from 'node:fs';
import { createGeminiAdapter } from '../src/adapters/gemini.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const modelId = process.argv[2] || 'gemini-argon-chat';
const modelConfig = config.models[modelId];

const tool = (name, parameters) => ({
    type: 'function',
    function: { name, description: `Probe tool ${name}`, parameters }
});

// VS Code's ask_user, reduced to the parts that matter: a form field definition is a
// union of variants, expressed as a property named `oneOf`, and variants carry
// `default`.
const FIELD_VARIANTS = {
    type: 'object',
    properties: {
        properties: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                properties: {
                    type: { type: 'string' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    oneOf: { type: 'array', items: { type: 'object' } },
                    default: { type: 'string' }
                },
                required: ['type', 'oneOf'],
                additionalProperties: false
            }
        }
    },
    required: ['properties']
};

const WITH_ANYOF = {
    type: 'object',
    properties: {
        choice: {
            anyOf: [
                { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
                { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] }
            ]
        }
    },
    required: ['choice']
};

const WITH_CONST = {
    type: 'object',
    properties: {
        kind: { const: 'fixed' },
        note: { type: 'string' }
    },
    required: ['kind']
};

const CASES = [
    { name: 'ask_user shape: properties named oneOf/default', tool: tool('ask_user', FIELD_VARIANTS) },
    { name: 'anyOf inside a property', tool: tool('anyof_probe', WITH_ANYOF) },
    { name: 'const inside a property', tool: tool('const_probe', WITH_CONST) }
];

const adapter = createGeminiAdapter();
console.log(`model: ${modelId}  (${modelConfig.adapterModel})\n`);

for (const testCase of CASES) {
    try {
        await adapter.chatComplete(modelConfig, {
            messages: [{ role: 'user', content: 'Say hi.' }],
            tools: [testCase.tool],
            maxTokens: 32,
            stream: false
        });
        console.log(`ACCEPT   ${testCase.name}`);
    } catch (error) {
        console.log(`REJECT   ${testCase.name}\n         ${error.message.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
}
