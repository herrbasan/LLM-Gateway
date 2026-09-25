import { expect } from 'chai';
import { validateConfig } from '../src/core/config-schema.js';
import { ModelRouter } from '../src/core/model-router.js';
import { createOpenAIAdapter } from '../src/adapters/openai.js';

function baseConfig(models = {}) {
    return {
        models: {
            'krea-2-image': {
                type: 'image',
                adapter: 'openai',
                endpoint: 'https://openrouter.ai/api/v1',
                apiKey: 'test-key',
                adapterModel: 'krea/krea-2-medium-turbo',
                capabilities: {
                    aspectRatios: ['1:1', '4:3', '3:2', '16:9', '2.35:1', '4:5', '2:3', '9:16']
                }
            },
            ...models
        },
        tasks: {
            imagegen: { model: 'krea-2-image', description: 'Image generation', default: true }
        }
    };
}

function imageApiResponse(b64 = 'aGVsbG8=') {
    return {
        created: 1758700000,
        data: [{ b64_json: b64, media_type: 'image/png' }],
        usage: { prompt_tokens: 20, completion_tokens: 4175, total_tokens: 4195, cost: 0.015 }
    };
}

function stubFetch(payload, status = 200) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        calls.push({ url, opts, body: JSON.parse(opts.body) });
        return new Response(JSON.stringify(payload), {
            status,
            headers: { 'content-type': 'application/json' }
        });
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
}

describe('Image Generation', () => {
    const kreaModelConfig = baseConfig().models['krea-2-image'];

    describe('config schema', () => {
        it('accepts type image with aspectRatios', () => {
            expect(() => validateConfig(baseConfig())).to.not.throw();
        });

        it('rejects malformed aspectRatios entries', () => {
            const config = baseConfig();
            config.models['krea-2-image'].capabilities.aspectRatios = ['wide'];
            expect(() => validateConfig(config)).to.throw(/aspectRatios/);
        });

        it('rejects invalid maxN', () => {
            const config = baseConfig();
            config.models['krea-2-image'].capabilities.maxN = 0;
            expect(() => validateConfig(config)).to.throw(/maxN/);
        });
    });

    describe('router', () => {
        it('rejects a missing prompt with 400', async () => {
            const router = new ModelRouter(baseConfig());
            try {
                await router.routeImageGeneration({ model: 'krea-2-image' });
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.status).to.equal(400);
                expect(err.message).to.match(/prompt/);
            }
        });

        it('rejects a chat model for image generation', async () => {
            const config = baseConfig({
                'some-chat': {
                    type: 'chat',
                    adapter: 'openai',
                    endpoint: 'http://localhost:1/v1',
                    adapterModel: 'x/y',
                    capabilities: { contextWindow: 4096 }
                }
            });
            const router = new ModelRouter(config);
            try {
                await router.routeImageGeneration({ model: 'some-chat', prompt: 'a cat' });
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.message).to.match(/type "chat"/);
            }
        });

        it('resolves the default image task when no model is given', async () => {
            const router = new ModelRouter(baseConfig());
            const { calls, restore } = stubFetch(imageApiResponse());
            try {
                const result = await router.routeImageGeneration({ prompt: 'a cat' });
                expect(result.model).to.equal('krea-2-image');
                expect(calls[0].body.model).to.equal('krea/krea-2-medium-turbo');
            } finally {
                restore();
            }
        });

        it('fetches reference images and forwards them as data URIs', async () => {
            const config = baseConfig({
                'qwen-image': {
                    type: 'image',
                    adapter: 'openai',
                    endpoint: 'https://openrouter.ai/api/v1',
                    apiKey: 'test-key',
                    adapterModel: 'qwen/qwen-image-3',
                    capabilities: { aspectRatios: ['1:1'], editing: true },
                    imageInputLimit: { maxDimension: 2048 }
                }
            });
            const router = new ModelRouter(config);
            const { calls, restore } = stubFetch(imageApiResponse());
            try {
                // MediaService is disabled in tests: references are fetched and
                // re-encoded as data URIs but not resized.
                await router.routeImageGeneration({
                    model: 'qwen-image',
                    prompt: 'make it blue',
                    input_references: ['data:image/png;base64,AAAA']
                });
                const refs = calls[0].body.input_references;
                expect(refs).to.have.length(1);
                expect(refs[0].type).to.equal('image_url');
                expect(refs[0].image_url.url).to.match(/^data:image\/(png|jpeg);base64,/);
            } finally {
                restore();
            }
        });
    });

    describe('openai adapter generateImage', () => {
        const modelConfig = kreaModelConfig;

        it('posts prompt to the /images endpoint and passes the response through', async () => {
            const adapter = createOpenAIAdapter();
            const { calls, restore } = stubFetch(imageApiResponse());
            try {
                const result = await adapter.generateImage(modelConfig, { prompt: 'a cat' });
                expect(calls[0].url).to.match(/\/images$/);
                const sent = calls[0].body;
                expect(sent.prompt).to.equal('a cat');
                expect(sent.model).to.equal('krea/krea-2-medium-turbo');
                expect(result.data).to.have.length(1);
                expect(result.data[0].b64_json).to.equal('aGVsbG8=');
                expect(result.created).to.equal(1758700000);
                expect(result.usage.cost).to.equal(0.015);
            } finally {
                restore();
            }
        });

        it('maps size WxH to the nearest declared aspect ratio', async () => {
            const adapter = createOpenAIAdapter();
            const { calls, restore } = stubFetch(imageApiResponse());
            try {
                await adapter.generateImage(modelConfig, { prompt: 'a cat', size: '1920x1080' });
                expect(calls[0].body.aspect_ratio).to.equal('16:9');
            } finally {
                restore();
            }
        });

        it('prefers an explicit aspect_ratio over size', async () => {
            const adapter = createOpenAIAdapter();
            const { calls, restore } = stubFetch(imageApiResponse());
            try {
                await adapter.generateImage(modelConfig, { prompt: 'a cat', size: '1024x1024', aspect_ratio: '9:16' });
                expect(calls[0].body.aspect_ratio).to.equal('9:16');
            } finally {
                restore();
            }
        });

        it('rejects an aspect ratio outside the declared set with 422', async () => {
            const adapter = createOpenAIAdapter();
            try {
                await adapter.generateImage(modelConfig, { prompt: 'a cat', aspect_ratio: '21:9' });
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.status).to.equal(422);
            }
        });

        it('rejects an invalid size string with 400', async () => {
            const adapter = createOpenAIAdapter();
            try {
                await adapter.generateImage(modelConfig, { prompt: 'a cat', size: 'big' });
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.status).to.equal(400);
            }
        });

        it('fails with 502 when the upstream returns no images', async () => {
            const adapter = createOpenAIAdapter();
            const { restore } = stubFetch({ created: 1758700000, data: [] });
            try {
                await adapter.generateImage(modelConfig, { prompt: 'a cat' });
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.status).to.equal(502);
                expect(err.message).to.match(/no images/);
            } finally {
                restore();
            }
        });

        it('passes extra_body extras through to the payload', async () => {
            const adapter = createOpenAIAdapter();
            const { calls, restore } = stubFetch(imageApiResponse());
            try {
                await adapter.generateImage(modelConfig, {
                    prompt: 'a cat',
                    seed: 42,
                    extra_body: { creativity: 'high', intensity: 30 }
                });
                const sent = calls[0].body;
                expect(sent.seed).to.equal(42);
                expect(sent.creativity).to.equal('high');
                expect(sent.intensity).to.equal(30);
            } finally {
                restore();
            }
        });
    });

    describe('image-to-image (input_references)', () => {
        const modelConfig = kreaModelConfig;
        const editingConfig = {
            ...baseConfig().models['krea-2-image'],
            adapterModel: 'qwen/qwen-image-3',
            capabilities: { aspectRatios: ['1:1'], editing: true }
        };

        it('normalizes string references to the verified wire shape', async () => {
            const adapter = createOpenAIAdapter();
            const { calls, restore } = stubFetch(imageApiResponse());
            try {
                await adapter.generateImage(editingConfig, {
                    prompt: 'make it blue',
                    input_references: ['data:image/png;base64,AAAA', { image_url: { url: 'data:image/png;base64,BBBB' } }]
                });
                expect(calls[0].body.input_references).to.deep.equal([
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }
                ]);
            } finally {
                restore();
            }
        });

        it('rejects input_references on a model without editing capability', async () => {
            const adapter = createOpenAIAdapter();
            try {
                await adapter.generateImage(modelConfig, {
                    prompt: 'make it blue',
                    input_references: ['data:image/png;base64,AAAA']
                });
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.status).to.equal(422);
                expect(err.message).to.match(/editing/);
            }
        });

        it('rejects malformed reference entries with 400', async () => {
            const adapter = createOpenAIAdapter();
            try {
                await adapter.generateImage(editingConfig, {
                    prompt: 'make it blue',
                    input_references: [123]
                });
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.status).to.equal(400);
            }
        });

        it('rejects an empty input_references array with 400', async () => {
            const adapter = createOpenAIAdapter();
            try {
                await adapter.generateImage(editingConfig, { prompt: 'make it blue', input_references: [] });
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.status).to.equal(400);
            }
        });
    });
});
