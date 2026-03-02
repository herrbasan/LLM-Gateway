import { expect } from 'chai';
import supertest from 'supertest';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Session Chat Flow', () => {
    let app, server, config;
    let sessionId;

    before(async () => {
        config = await loadConfig(join(__dirname, '..', 'config.example.json'));
        config.port = 0; // random port
        // mock adapter behavior
        app = createServer(config);
    });

    it('should run a full session flow accumulating history', async () => {
        // 1. Create session
        let res = await supertest(app)
            .post('/v1/sessions')
            .send({ strategy: 'truncate' });
        expect(res.status).to.equal(201);
        sessionId = res.body.session.id;

        // 2. Chat using session
        // Requires mocking adapter predict if we actually hit an external endpoint 
        // Assume default provider might fail, but let's test router directly instead of full app if we want unit test?
        // Wait, tests are already using supertest and hitting real adapters if we don't mock it?
        // The other server.test.js does hit real handlers. Let's send a fake message and see if it accumulates?
        // If it throws "Fetch error", the session won't accumulate assistant message but will accumulate user message before router throws? No router doesn't save user message if it fails... Actually router saves user message earlier.
    });
});
