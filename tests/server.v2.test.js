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
            expect(res.body.data.length).to.equal(Object.keys(config.models).length);
            
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
            expect(res.body.error).to.include('Unknown model');
        });

        it('returns 400 for wrong model type', async () => {
            // Find an embedding model
            const embedModel = Object.entries(config.models).find(
                ([_, m]) => m.type === 'embedding'
            );
            
            if (!embedModel) {
                console.log('[SKIP] No embedding model to test');
                return;
            }

            const res = await supertest(app)
                .post('/v1/chat/completions')
                .send({
                    model: embedModel[0],
                    messages: [{ role: 'user', content: 'Hi' }]
                });
            
            expect(res.status).to.equal(400);
            expect(res.body.error).to.include('type');
        });
    });

    describe('POST /v1/embeddings - Error Cases', () => {
        it('returns 404 for unknown model', async () => {
            const res = await supertest(app)
                .post('/v1/embeddings')
                .send({
                    model: 'nonexistent-model-xyz',
                    input: 'test'
                });
            
            expect(res.status).to.equal(404);
        });
    });

    describe('POST /v1/images/generations - Error Cases', () => {
        it('returns 400 for missing prompt', async () => {
            const res = await supertest(app)
                .post('/v1/images/generations')
                .send({});
            
            expect(res.status).to.equal(400);
            expect(res.body.error).to.include('prompt');
        });
    });

    describe('POST /v1/audio/speech - Error Cases', () => {
        it('returns 400 for missing input', async () => {
            const res = await supertest(app)
                .post('/v1/audio/speech')
                .send({ voice: 'alloy' });
            
            expect(res.status).to.equal(400);
            expect(res.body.error).to.include('input');
        });
    });
});
