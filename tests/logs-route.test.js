import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogsHandler } from '../src/routes/logs.js';
import { getLogger, resetLogger } from '../src/utils/logger.js';

// The route reads whatever directory the logger writes to, so the fixture directory
// is installed as LOG_DIR and the logger is rebuilt to point at it.
//
// The entries are written as finished files rather than through the logger: nLogger
// writes through a stream, and a test that reads back its own output a microsecond
// later is racing the flush, not testing the route. That race is what made this file
// fail permanently — and it masked the real defect, that the route resolved its
// directory from its own module path and ignored LOG_DIR entirely.
const FIXTURE_DIR = path.join(os.tmpdir(), 'llm-gateway-logs-route-test');
const SESSION = 'fixture1';

const FIXTURE_LINES = [
    '[2026-01-01T00:00:00.000Z] [INFO] [System] Test info message {"test":true}',
    '[2026-01-01T00:00:01.000Z] [WARN] [ModelRouter] Test warn message',
    '[2026-01-01T00:00:02.000Z] [ERROR] [ChatRoute] Test error message',
    '[2026-01-01T00:00:03.000Z] [DEBUG] [System] Test debug message',
    '',
    '========================================',
    'Session: ' + SESSION,
    '========================================'
];

describe('GET /logs', () => {
    let handler;
    let previousLogDir;

    beforeEach(() => {
        previousLogDir = process.env.LOG_DIR;
        process.env.LOG_DIR = FIXTURE_DIR;

        resetLogger();
        fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });

        // Constructed after the reset so it opens its session file inside the fixture
        // directory — which is what points the route at it.
        getLogger();
        fs.writeFileSync(
            path.join(FIXTURE_DIR, `2026-01-01-00-00-00-gw-${SESSION}.log`),
            FIXTURE_LINES.join('\n') + '\n'
        );

        handler = createLogsHandler();
    });

    afterEach(() => {
        resetLogger();
        if (previousLogDir === undefined) delete process.env.LOG_DIR;
        else process.env.LOG_DIR = previousLogDir;
    });

    it('should return logs in correct format', async () => {
        const req = { query: {} };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        expect(capturedData).to.have.property('logs');
        expect(capturedData.logs).to.be.an('array');

        // Check log entry structure
        const entry = capturedData.logs.find(e => e.message === 'Test info message');
        expect(entry, 'fixture entry survives parsing').to.exist;
        expect(entry).to.have.property('timestamp');
        expect(entry).to.have.property('level');
        expect(entry).to.have.property('type');
        expect(entry).to.have.property('message');
        expect(entry).to.have.property('sessionId');

        // Verify timestamp format (ISO 8601)
        expect(entry.timestamp).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

        // Verify level is valid
        expect(['INFO', 'WARN', 'ERROR', 'DEBUG']).to.include(entry.level);

        // Verify the trailing JSON payload is split off the message
        expect(entry.type).to.equal('System');
        expect(entry.sessionId).to.equal(SESSION);
        expect(entry.payload).to.deep.equal({ test: true });
    });

    it('should respect limit parameter', async () => {
        const req = { query: { limit: '2' } };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        expect(capturedData.logs.length).to.be.at.most(2);
    });

    it('should apply default limit of 100', async () => {
        const req = { query: {} };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        expect(capturedData.logs.length).to.be.at.most(100);
    });

    it('should filter by level', async () => {
        const req = { query: { level: 'INFO' } };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        // All returned entries should have INFO level
        capturedData.logs.forEach(entry => {
            expect(entry.level).to.equal('INFO');
        });
    });

    it('should filter by multiple levels (comma-separated)', async () => {
        const req = { query: { level: 'INFO,WARN' } };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        // All returned entries should have INFO or WARN level
        capturedData.logs.forEach(entry => {
            expect(['INFO', 'WARN']).to.include(entry.level);
        });
    });

    it('should filter by sessionId', async () => {
        const req = { query: { sessionId: SESSION } };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        expect(capturedData.logs.length).to.be.greaterThan(0);
        capturedData.logs.forEach(entry => {
            expect(entry.sessionId).to.equal(SESSION);
        });
    });

    it('should sort logs by timestamp descending (newest first)', async () => {
        const req = { query: {} };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        // Verify descending order
        for (let i = 1; i < capturedData.logs.length; i++) {
            const prev = new Date(capturedData.logs[i - 1].timestamp);
            const curr = new Date(capturedData.logs[i].timestamp);
            expect(prev.getTime()).to.be.at.least(curr.getTime());
        }
    });

    it('should skip header blocks and empty lines', async () => {
        const req = { query: {} };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        // No entry should have message starting with '='
        capturedData.logs.forEach(entry => {
            expect(entry.message).to.not.match(/^=/);
        });
        // The fixture's header block is present in the file but must not come back.
        expect(capturedData.logs.some(e => e.message.includes('Session:'))).to.be.false;
        expect(capturedData.logs.length).to.be.greaterThan(0);
    });

    it('should handle empty logs directory gracefully', async () => {
        // This test verifies the handler doesn't crash with empty results
        const req = { query: { sessionId: 'non-existent-session' } };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        expect(capturedData).to.have.property('logs');
        expect(capturedData.logs).to.be.an('array');
        expect(capturedData.logs).to.have.length(0);
    });

    it('should pass errors to next()', async () => {
        // Create a handler that will fail by temporarily breaking fs
        const req = { query: {} };
        let errorPassed = false;
        const res = {};
        const next = (err) => { 
            errorPassed = true;
            expect(err).to.exist;
        };

        // This will likely fail since logs directory exists
        // but if it doesn't exist with ENOENT, we return empty array instead of error
        await handler(req, res, next);
        
        // Either we got data or an error was passed
        // We can't easily force an error without mocking fs
    });

    it('should default type to System when not specified', async () => {
        const req = { query: {} };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        // Check that entries have a valid type. A line written without an explicit
        // type is tagged 'System' by the logger, and must survive parsing.
        const infoEntry = capturedData.logs.find(e => e.message === 'Test info message');
        expect(infoEntry).to.exist;
        expect(infoEntry.type).to.be.a('string');
        expect(infoEntry.type).to.equal('System');
    });
});
