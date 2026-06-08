import { expect } from 'chai';
import supertest from 'supertest';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('Resilience & Circuit Breaker', () => {
    let app;
    let config;

    before(async () => {
        config = await loadConfig();

        // Add a fake model that points to a non-existent endpoint.
        // All requests to it will fail with ECONNREFUSED, tripping the circuit breaker.
        config.models['fake-down'] = {
            type: 'chat',
            adapter: 'lmstudio',
            endpoint: 'http://localhost:55555',
            adapterModel: 'fake-model',
            capabilities: {
                contextWindow: 8192,
                streaming: true
            }
        };

        // Set default task to our fake model so requests without
        // an explicit model also hit it
        config.tasks = config.tasks || {};
        config.tasks.query = { model: 'fake-down', default: true };

        app = createServer(config);
    });

    it('should show metrics on /health endpoint', async () => {
        const response = await supertest(app).get('/health');
        expect(response.status).to.equal(200);
        expect(response.body).to.have.property('status', 'ok');
        expect(response.body).to.have.property('adapters');
        expect(response.body.adapters).to.have.property('lmstudio');

        const lmstudioBreakers = response.body.adapters.lmstudio;
        expect(lmstudioBreakers).to.have.property('chat');
        expect(lmstudioBreakers.chat).to.have.property('state', 'CLOSED');
        expect(lmstudioBreakers.chat).to.have.property('totalRequests', 0);
    });

    it('should trip the circuit breaker for fake model', async function () {
        // Because of retry logic in fetch (default 3 retries), each request will take
        // 500ms + 1000ms + 2000ms... over 3 seconds if we didn't tweak limits, but we let it run.
        this.timeout(25000);

        // The chat circuit breaker threshold is 3. We'll fire 4 requests to make sure it trips.
        for (let i = 0; i < 4; i++) {
            await supertest(app)
                .post('/v1/chat/completions')
                .send({
                    model: 'fake-down',
                    messages: [{ role: 'user', content: 'hello' }]
                });
        }

        const response = await supertest(app).get('/health');
        const chatMetrics = response.body.adapters.lmstudio.chat;

        // It failed 4 times (meaning it tripped on the 3rd and fast-failed on the 4th)
        expect(['OPEN', 'HALF-OPEN']).to.include(chatMetrics.state);
        expect(chatMetrics.totalRequests).to.equal(4);
        expect(chatMetrics.shortCircuitedRequests).to.be.at.least(1);
    });

    it('should fail fast with 503 for a short-circuited request', async () => {
        const response = await supertest(app)
            .post('/v1/chat/completions')
            .send({
                model: 'fake-down',
                messages: [{ role: 'user', content: 'impatient hello' }]
            });

         expect(response.status).to.equal(503);
         expect(response.body).to.have.property('error');
         expect(response.body.error.message).to.include('Circuit is OPEN');
    });
});
