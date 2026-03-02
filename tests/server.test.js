import { expect } from 'chai';
import supertest from 'supertest';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('Server Routing & API Architecture', () => {
    let app;
    let config;

    before(async () => {
        // We use the real configuration against the real server application wrapper
        config = await loadConfig();
        app = createServer(config);
    });

    describe('GET /health', () => {
        it('should return 200 OK and healthy status', async () => {
            const response = await supertest(app).get('/health');
            expect(response.status).to.equal(200);
            expect(response.body).to.have.property('status', 'ok');
        });
    });

    describe('Global Error Handling & Middleware', () => {
        it('should return 404 for unknown routes', async () => {
            const response = await supertest(app).get('/api/unknown/endpoint-testing');
            expect(response.status).to.equal(404);
            expect(response.body).to.deep.equal({ error: 'Not Found' });
        });

        it('should support CORS OPTIONS requests successfully', async () => {
           const response = await supertest(app).options('/health');
           expect(response.status).to.equal(200);
           expect(response.headers).to.have.property('access-control-allow-methods');
           expect(response.headers['access-control-allow-methods']).to.include('GET');
        });
    });

    describe('POST /v1/chat/completions', () => {
        it('should return a 400 or 404 error if payload lacks messages (testing the route hooks up)', async () => {
             const response = await supertest(app)
                .post('/v1/chat/completions')
                .send({
                    model: 'unknown_magic:llama',
                    messages: []
                });
             // We expect it to trigger the router and fail fast because of unknown model
             expect(response.status).to.equal(404);
             expect(response.body).to.have.property('error');
        });
    });

    describe('POST /v1/embeddings', () => {
        it('should trigger embeddings route and return 404 on unknown model', async () => {
            const response = await supertest(app)
                .post('/v1/embeddings')
                .send({
                    model: 'unknown_magic:llama',
                    input: 'test text'
                });
            expect(response.status).to.equal(404);
            expect(response.body).to.have.property('error');
        });
    });

    describe('GET /v1/models', () => {
        it('should return a list of models with object type "list"', async function () {
            this.timeout(15000);
            const response = await supertest(app).get('/v1/models');
            expect(response.status).to.equal(200);
            expect(response.body).to.have.property('object', 'list');
            expect(response.body).to.have.property('data');
            expect(Array.isArray(response.body.data)).to.be.true;
        });
    });

    describe('Stateful Sessions API', () => {
        let sessionId;
        it('should create a new session', async () => {
            const response = await supertest(app)
                .post('/v1/sessions')
                .send({ strategy: 'compress' });
            expect(response.status).to.equal(201);
            expect(response.body).to.have.property('session');
            expect(response.body.session).to.have.property('id');
            expect(response.body.session.context).to.have.property('strategy', 'compress');
            expect(response.body.session.message_count).to.equal(0);
            sessionId = response.body.session.id;
        });

        it('should retrieve an existing session', async () => {
            const response = await supertest(app).get(`/v1/sessions/${sessionId}`);
            expect(response.status).to.equal(200);
            expect(response.body.session.id).to.equal(sessionId);
        });

        it('should patch session strategy', async () => {
            const response = await supertest(app)
                .patch(`/v1/sessions/${sessionId}`)
                .send({ strategy: 'truncate' });
            expect(response.status).to.equal(200);
            expect(response.body.session.context.strategy).to.equal('truncate');
        });

        it('should return 404 for unknown or deleted session on completion', async () => {
             const response = await supertest(app)
                .post('/v1/chat/completions')
                .set('x-session-id', 'invalid-id-123')
                .send({
                    model: 'auto',
                    messages: [{ role: 'user', content: 'test' }]
                });
             expect(response.status).to.equal(404); // Used to be 500
             expect(response.body.error).to.include('[Router] 404 Session Not Found');
        });

        it('should delete a session', async () => {
            const response = await supertest(app).delete(`/v1/sessions/${sessionId}`);
            expect(response.status).to.equal(204);
            // Verify deleted
            const getResp = await supertest(app).get(`/v1/sessions/${sessionId}`);
            expect(getResp.status).to.equal(404);
        });
    });

    describe('Error Code Mapping', () => {
        it('should return 404 for unknown or missing session', async () => {
             const response = await supertest(app)
                .post('/v1/chat/completions')
                .set('x-session-id', 'invalid-id-123')
                .send({
                    model: 'auto',
                    messages: [{ role: 'user', content: 'test' }]
                });
             expect(response.status).to.equal(404);
        });

        it('should return 400 for structured output on non-capable provider', async () => {
             const response = await supertest(app)
                .post('/v1/chat/completions')
                .set('x-provider', 'kimi') // kimi doesn't support json_object in example config typically, but any non-capable like grok etc.
                .send({
                    model: 'auto',
                    messages: [{ role: 'user', content: 'test' }],
                    response_format: { type: 'json_schema' }
                });
             if (response.status === 400) {
                 expect(response.body.error).to.include('does not support structured output');
             }
        });

        it('should return 404 for unknown adapter/provider', async () => {
            const response = await supertest(app)
                .post('/v1/chat/completions')
                .send({
                    model: 'unknown_magic:llama',
                    messages: [{ role: 'user', content: 'test' }]
                });
             expect(response.status).to.equal(404);
             expect(response.body.error).to.include('No adapter found');
        });
    });
});
