const express = require('express');
const request = require('supertest');
const { expect } = require('chai');

const router = require('../routes/api');

describe('WebAdmin Realtime Monitor API', () => {
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

    it('returns monitor snapshot with gateway health', async () => {
        global.fetch = async (url) => {
            if (String(url).endsWith('/health')) {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    async json() {
                        return {
                            status: 'ok',
                            providers: {
                                lmstudio: { state: 'CLOSED', failures: 0, successRate: 1 }
                            }
                        };
                    }
                };
            }

            throw new Error(`Unexpected URL: ${url}`);
        };

        const res = await request(app).get('/api/monitor/state');

        expect(res.status).to.equal(200);
        expect(res.body.gateway.status).to.equal('ok');
        expect(res.body.webadmin).to.have.property('in_flight');
        expect(res.body.webadmin).to.have.property('connected_clients');
        expect(Array.isArray(res.body.recentEvents)).to.equal(true);
    });

    it('records proxy activity in monitor snapshot', async () => {
        global.fetch = async (url, options = {}) => {
            const u = String(url);

            if (u.endsWith('/health')) {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    async json() {
                        return { status: 'ok', providers: {} };
                    }
                };
            }

            if (u.includes('/v1/images/generations')) {
                return {
                    ok: true,
                    status: 202,
                    headers: { get: () => 'application/json' },
                    async json() {
                        return {
                            object: 'media.generation.task',
                            ticket: 'tkt_monitor_test',
                            status: 'accepted'
                        };
                    }
                };
            }

            throw new Error(`Unexpected URL: ${url}`);
        };

        const proxyRes = await request(app)
            .post('/api/proxy/images/generations')
            .send({ prompt: 'monitor test image' });

        expect(proxyRes.status).to.equal(202);

        const stateRes = await request(app).get('/api/monitor/state');
        expect(stateRes.status).to.equal(200);

        const found = (stateRes.body.recentEvents || []).some(
            (ev) => ev.endpoint === '/v1/images/generations' && ev.method === 'POST'
        );

        expect(found).to.equal(true);
    });
});
