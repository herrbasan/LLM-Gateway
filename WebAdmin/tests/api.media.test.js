const express = require('express');
const request = require('supertest');
const { expect } = require('chai');

const router = require('../routes/api');

describe('WebAdmin Media Proxy Routes', () => {
    let app;
    let originalFetch;

    beforeEach(() => {
        app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use('/api', router);

        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('proxies image generation and returns 202 ticket payload', async () => {
        global.fetch = async (url, options) => {
            expect(url).to.include('/v1/images/generations');
            expect(options.method).to.equal('POST');
            expect(options.headers['x-provider']).to.equal('openai');

            return {
                status: 202,
                headers: {
                    get: () => 'application/json'
                },
                async json() {
                    return {
                        object: 'media.generation.task',
                        ticket: 'tkt_test123',
                        status: 'accepted',
                        stream_url: '/v1/tasks/tkt_test123/stream'
                    };
                }
            };
        };

        const res = await request(app)
            .post('/api/proxy/images/generations')
            .send({
                provider: 'openai',
                model: 'openai:gpt-image-1',
                prompt: 'A watercolor fox',
                response_format: 'b64_json'
            });

        expect(res.status).to.equal(202);
        expect(res.body.ticket).to.equal('tkt_test123');
        expect(res.body.object).to.equal('media.generation.task');
    });

    it('proxies audio speech and forwards binary response', async () => {
        global.fetch = async (url, options) => {
            expect(url).to.include('/v1/audio/speech');
            expect(options.method).to.equal('POST');

            const payload = Buffer.from('fake-audio-binary');
            return {
                ok: true,
                status: 200,
                headers: {
                    get: (name) => name.toLowerCase() === 'content-type' ? 'audio/mpeg' : null
                },
                async arrayBuffer() {
                    return payload;
                },
                async text() {
                    return '';
                }
            };
        };

        const res = await request(app)
            .post('/api/proxy/audio/speech')
            .send({
                model: 'openai:gpt-4o-mini-tts',
                input: 'Hello from WebAdmin',
                voice: 'alloy',
                response_format: 'mp3'
            });

        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.include('audio/mpeg');
        expect(Buffer.isBuffer(res.body)).to.equal(true);
    });

    it('proxies staged media file download', async () => {
        global.fetch = async (url) => {
            expect(url).to.include('/v1/media/media_test.png');

            const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
            return {
                ok: true,
                status: 200,
                headers: {
                    get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null
                },
                async arrayBuffer() {
                    return payload;
                },
                async text() {
                    return '';
                }
            };
        };

        const res = await request(app)
            .get('/api/proxy/media/media_test.png');

        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.include('image/png');
        expect(Buffer.isBuffer(res.body)).to.equal(true);
    });

    it('proxies task status for media ticket polling', async () => {
        global.fetch = async (url) => {
            expect(url).to.include('/v1/tasks/tkt_media123');
            return {
                status: 200,
                headers: {
                    get: () => 'application/json'
                },
                async json() {
                    return {
                        object: 'media.generation.task',
                        ticket: 'tkt_media123',
                        status: 'complete',
                        result: {
                            data: [
                                {
                                    b64_json: 'ZmFrZQ==',
                                    local_url: '/v1/media/media_abc.png'
                                }
                            ]
                        }
                    };
                }
            };
        };

        const res = await request(app)
            .get('/api/tasks/tkt_media123');

        expect(res.status).to.equal(200);
        expect(res.body.status).to.equal('complete');
        expect(res.body.result.data[0].local_url).to.equal('/v1/media/media_abc.png');
    });
});
