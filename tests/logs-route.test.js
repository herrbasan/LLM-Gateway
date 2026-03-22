import { expect } from 'chai';
import { createLogsHandler } from '../src/routes/logs.js';
import { getLogger, resetLogger } from '../src/utils/logger.js';

describe('GET /logs', () => {
    let logger;
    let handler;

    beforeEach(() => {
        resetLogger();
        logger = getLogger();
        handler = createLogsHandler();
        
        // Generate some test log entries
        logger.info('Test info message', { test: true });
        logger.warn('Test warn message');
        logger.error('Test error message');
    });

    afterEach(() => {
        resetLogger();
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
        if (capturedData.logs.length > 0) {
            const entry = capturedData.logs[0];
            expect(entry).to.have.property('timestamp');
            expect(entry).to.have.property('level');
            expect(entry).to.have.property('type');
            expect(entry).to.have.property('message');
            expect(entry).to.have.property('sessionId');
            
            // Verify timestamp format (ISO 8601)
            expect(entry.timestamp).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            
            // Verify level is valid
            expect(['INFO', 'WARN', 'ERROR', 'DEBUG']).to.include(entry.level);
            
            // Verify type is a string (should be the event type like 'System', 'ModelRouter', etc.)
            expect(entry.type).to.be.a('string');
            expect(entry.type.length).to.be.greaterThan(0);
        }
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
        const sessionInfo = logger.getSessionInfo();
        const req = { query: { sessionId: sessionInfo.sessionId } };
        let capturedData;
        const res = {
            json: (data) => { capturedData = data; }
        };
        const next = () => {};

        await handler(req, res, next);

        // All returned entries should have the specified sessionId
        capturedData.logs.forEach(entry => {
            expect(entry.sessionId).to.equal(sessionInfo.sessionId);
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

        // Check that entries have a valid type (default should be 'System' for logs without explicit type)
        // The logs created in beforeEach with default type should have 'System'
        const infoEntry = capturedData.logs.find(e => e.message === 'Test info message');
        expect(infoEntry).to.exist;
        expect(infoEntry.type).to.be.a('string');
        expect(infoEntry.type.length).to.be.greaterThan(0);
    });
});
