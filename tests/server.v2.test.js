/**
 * Server API Tests - Real World
 * Tests actual HTTP endpoints with real server.
 * No mocks. Uses real config, real data where possible.
 */

import { expect } from 'chai';
import supertest from 'supertest';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('Server v2 - Real World', () => {
    let app;
    let config;

    before(async () => {
        config = await loadConfig();
        config.authDisabled = true;
        app = createServer(config);
    });

    describe('GET /health', () => {
        it('returns healthy status', async () => {
            const res = await supertest(app).get('/health');
            
            expect(res.status).to.equal(200);
            expect(res.body.status).to.equal('ok');
            expect(res.body.version).to.equal('2.0.0');
            expect(res.body.models).to.be.an('array');
        });
    });

    describe('GET /v1/models', () => {
        it('returns flat model list from config', async () => {
            const res = await supertest(app).get('/v1/models');
            
            expect(res.status).to.equal(200);
            expect(res.body.object).to.equal('list');
            expect(res.body.data).to.be.an('array');
            const expectedCount = Object.entries(config.models).filter(([k, m]) => !m.disabled && !k.startsWith('_comment')).length;
            expect(res.body.data.length).to.equal(expectedCount);
            
            // Verify structure
            const model = res.body.data[0];
            expect(model).to.have.property('id');
            expect(model).to.have.property('capabilities');
            expect(model).to.have.property('owned_by');
        });
    });

    describe('404 Handling', () => {
        it('returns 404 for unknown routes', async () => {
            const res = await supertest(app).get('/nonexistent');
            
            expect(res.status).to.equal(404);
            expect(res.body.error).to.equal('Not Found');
        });
    });

    describe('POST /v1/chat/completions - Error Cases', () => {
        it('returns 404 for unknown model', async () => {
            const res = await supertest(app)
                .post('/v1/chat/completions')
                .send({
                    model: 'nonexistent-model-xyz',
                    messages: [{ role: 'user', content: 'Hi' }]
                });
            
            expect(res.status).to.equal(404);
            expect(res.body.error.message).to.include('Unknown model');
        });

        it('returns 400 for wrong model type', async () => {
            // Find an enabled embedding model
            const embedModel = Object.entries(config.models).find(
                ([_, m]) => m.type === 'embedding' && !m.disabled
            );
            
            if (!embedModel) {
                console.log('[SKIP] No enabled embedding model to test');
                return;
            }

            const res = await supertest(app)
                .post('/v1/chat/completions')
                .send({
                    model: embedModel[0],
                    messages: [{ role: 'user', content: 'Hi' }]
                });
            
            expect(res.status).to.equal(400);
            expect(res.body.error.message).to.include('type');
        });
    });
});
