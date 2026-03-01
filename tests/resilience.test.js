import { expect } from 'chai';
import supertest from 'supertest';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('Resilience & Circuit Breaker', () => {
    let app;
    let config;

    before(async () => {
        config = await loadConfig();
        
        // Let's create an invalid provider deliberately so requests to it will trip the circuit breaker.
        // We inject it into the config before setting up the server.
        config.providers.fake_down = {
            type: 'lmstudio',
            endpoint: 'http://localhost:55555', // unlikely to ever be open
            model: 'fake-model',
            enabled: true
        };

        app = createServer(config);
    });

    it('should show metrics on /health endpoint', async () => {
        const response = await supertest(app).get('/health');
        expect(response.status).to.equal(200);
        expect(response.body).to.have.property('status', 'ok');
        expect(response.body).to.have.property('providers');
        expect(response.body.providers).to.have.property('fake_down');
        
        const metrics = response.body.providers.fake_down;
        expect(metrics).to.have.property('state', 'CLOSED');
        expect(metrics).to.have.property('totalRequests', 0);
    });

    it('should trip the circuit breaker for fake_down provider', async function () {
        // Because of our retry logic in fetch (default 3 retries), each request will take 
        // 500ms + 1000ms + 2000ms... over 3 seconds if we didn't tweak limits, but we let it run.
        this.timeout(25000); 

        // The circuit breaker threshold is 3. We'll fire 4 requests to make sure it trips.
        for (let i = 0; i < 4; i++) {
            await supertest(app)
                .post('/v1/chat/completions')
                .set('x-provider', 'fake_down')
                .send({
                    model: 'fake-model',
                    messages: [{ role: 'user', content: 'hello' }]
                });
        }

        const response = await supertest(app).get('/health');
        const metrics = response.body.providers.fake_down;
        
        // It failed 4 times (meaning it tripped on the 3rd and fast-failed on the 4th)
        expect(['OPEN', 'HALF-OPEN']).to.include(metrics.state);
        expect(metrics.totalRequests).to.equal(4);
        expect(metrics.shortCircuitedRequests).to.be.at.least(1); 
    });

    it('should fail fast with 503 for a short-circuited request', async () => {
         const response = await supertest(app)
            .post('/v1/chat/completions')
            .set('x-provider', 'fake_down')
            .send({
                model: 'fake-model',
                messages: [{ role: 'user', content: 'impatient hello' }]
            });

         expect(response.status).to.equal(503);
         expect(response.body).to.have.property('error');
         expect(response.body.error).to.include('Circuit is OPEN');
    });
});
