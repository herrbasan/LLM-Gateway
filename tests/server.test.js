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
});
