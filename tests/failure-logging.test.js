/**
 * Failure logging: client identity and repeat aggregation.
 *
 * These two helpers exist because an incident in the log has to answer "who is
 * this happening to?" and "is this one problem or seven?" — the questions that
 * cost the most time when a session breaks and the log only says which model
 * returned which status.
 */

import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { describeClient, clientKey } from '../src/utils/client-identity.js';
import { logFailure, resetFailureState } from '../src/utils/failure-log.js';

function fakeLogger() {
    const lines = [];
    return {
        lines,
        error: (message, data, meta, component) => lines.push({ level: 'error', message, data, meta, component }),
        warn: (message, data, meta, component) => lines.push({ level: 'warn', message, data, meta, component })
    };
}

const request = (headers = {}) => ({ headers, ip: '192.168.0.42' });

describe('describeClient', () => {
    it('always reports address and user agent', () => {
        const client = describeClient(request({ 'user-agent': 'llm-gateway-copilot/0.3.0' }));
        expect(client).to.deep.equal({ ip: '192.168.0.42', userAgent: 'llm-gateway-copilot/0.3.0' });
    });

    it('includes the optional naming headers when a client sends them', () => {
        const client = describeClient(request({
            'user-agent': 'x',
            'x-client-name': 'chat-app',
            'x-client-version': '2.1.0',
            'x-session-id': 'chat_1789417017832_otqkmrxs'
        }));
        expect(client.clientName).to.equal('chat-app');
        expect(client.clientVersion).to.equal('2.1.0');
        expect(client.sessionId).to.equal('chat_1789417017832_otqkmrxs');
    });

    it('truncates a novel-length user agent', () => {
        const client = describeClient(request({ 'user-agent': 'u'.repeat(500) }));
        expect(client.userAgent).to.have.length(120);
    });

    it('falls back to the socket address when req.ip is absent', () => {
        const client = describeClient({ headers: {}, socket: { remoteAddress: '::1' } });
        expect(client.ip).to.equal('::1');
    });

    it('throws when given no request', () => {
        expect(() => describeClient(null)).to.throw(/requires the request object/);
    });

    it('takes the first value of a repeated header', () => {
        const client = describeClient(request({ 'x-session-id': ['first', 'second'] }));
        expect(client.sessionId).to.equal('first');
    });
});

describe('clientKey', () => {
    it('separates two windows of the same client by session', () => {
        const a = clientKey({ clientName: 'copilot', sessionId: 'aaa' });
        const b = clientKey({ clientName: 'copilot', sessionId: 'bbb' });
        expect(a).to.not.equal(b);
    });

    it('collapses anonymous clients to an address/user-agent key', () => {
        const key = clientKey({ ip: '10.0.0.1', userAgent: 'curl/8' });
        expect(key).to.equal('unnamed|10.0.0.1|curl/8');
    });

    it('names the absence of a client', () => {
        expect(clientKey(null)).to.equal('unknown');
    });
});

describe('logFailure', () => {
    beforeEach(() => resetFailureState());

    it('logs once per failure and counts the repeats', () => {
        const logger = fakeLogger();
        const first = logFailure({ logger, component: 'StreamHandler', message: 'boom', meta: { type: 'upstream_error', code: 'ZERO_CONTENT', model: 'm' } });
        const second = logFailure({ logger, component: 'StreamHandler', message: 'boom', meta: { type: 'upstream_error', code: 'ZERO_CONTENT', model: 'm' } });

        expect(first.count).to.equal(1);
        expect(second.count).to.equal(2);
        expect(logger.lines).to.have.length(2, 'every occurrence is still logged');
        expect(logger.lines[1].meta.failure.firstSeenAt).to.equal(logger.lines[0].meta.failure.firstSeenAt);
    });

    it('groups failures whose message varies but whose cause is the same', () => {
        const logger = fakeLogger();
        const meta = { type: 'invalid_request_error', code: 'UPSTREAM_HTTP_400', model: 'deepseek-flash-chat', adapter: 'anthropic' };
        logFailure({ logger, component: 'StreamHandler', message: 'HTTP Error 400: retry in 33s', meta });
        const second = logFailure({ logger, component: 'StreamHandler', message: 'HTTP Error 400: retry in 31s', meta });
        expect(second.count).to.equal(2);
    });

    it('keeps failures of different models apart', () => {
        const logger = fakeLogger();
        const base = { type: 'invalid_request_error', code: 'UPSTREAM_HTTP_400' };
        logFailure({ logger, component: 'StreamHandler', message: 'boom', meta: { ...base, model: 'a' } });
        const other = logFailure({ logger, component: 'StreamHandler', message: 'boom', meta: { ...base, model: 'b' } });
        expect(other.count).to.equal(1);
    });

    it('counts distinct clients, not occurrences', () => {
        const logger = fakeLogger();
        const meta = (sessionId) => ({ code: 'RATE_LIMIT', client: { clientName: 'copilot', sessionId } });
        logFailure({ logger, component: 'StreamHandler', message: 'boom', meta: meta('one') });
        logFailure({ logger, component: 'StreamHandler', message: 'boom', meta: meta('one') });
        const third = logFailure({ logger, component: 'StreamHandler', message: 'boom', meta: meta('two') });

        expect(third.count).to.equal(3);
        expect(third.distinctClients).to.equal(2);
    });

    it('keeps client identity on the line', () => {
        const logger = fakeLogger();
        const client = { ip: '10.0.0.5', userAgent: 'x', sessionId: 's1' };
        logFailure({ logger, component: 'Server', message: 'boom', meta: { client } });
        expect(logger.lines[0].meta.client).to.equal(client);
    });

    it('supports warn severity for rejected requests', () => {
        const logger = fakeLogger();
        logFailure({ logger, component: 'Server', level: 'warn', message: 'boom' });
        expect(logger.lines[0].level).to.equal('warn');
    });

    it('refuses an unknown level rather than silently mislabelling a failure', () => {
        expect(() => logFailure({ logger: fakeLogger(), component: 'Server', level: 'info', message: 'boom' }))
            .to.throw(/level must be 'warn' or 'error'/);
    });

    it('refuses to log without a message or a logger', () => {
        expect(() => logFailure({ logger: fakeLogger(), component: 'Server' })).to.throw(/requires a message/);
        expect(() => logFailure({ component: 'Server', message: 'boom' })).to.throw(/requires a logger/);
    });
});
