import { expect } from 'chai';
import { Router } from '../src/core/router.js';
import { loadConfig } from '../src/config.js';
import { TokenEstimator } from '../src/context/estimator.js';
import { ContextManager } from '../src/context/strategy.js';
import { TicketRegistry } from '../src/core/ticket-registry.js';

describe('Phase 4: Context Window Management', function() {
    this.timeout(15000);

    let config;
    
    before(async () => {
        config = await loadConfig();
    });

    it('should estimate tokens using character heuristic fallback', async () => {
        const estimator = new TokenEstimator(config);
        const text = "Hello world, this is a test string.";
        const tokens = await estimator.estimate(text, null, 'auto');
        expect(tokens).to.be.a('number');
        expect(tokens).to.be.greaterThan(0);
    });

    it('should truncate messages when they exceed available tokens', async () => {
        // Force the minTokensToCompact to be very low and context window low
        const testConfig = {
            ...config,
            compaction: {
                enabled: true,
                minTokensToCompact: 10,
                preserveSystemPrompt: true,
                preserveLastN: 1,
                mode: 'truncate'
            }
        };

        const router = new Router(testConfig);
        
        // Mock adapter token boundaries to trigger truncate deterministically
        const defaultAdapter = router.adapters.get(router.defaultProvider);
        const originalGetContextWindow = defaultAdapter.getContextWindow.bind(defaultAdapter);
        const originalCountTokens = defaultAdapter.countTokens ? defaultAdapter.countTokens.bind(defaultAdapter) : null;
        defaultAdapter.getContextWindow = async () => 2000;
        defaultAdapter.countTokens = async (text) => {
            if (text === 'System rules here. This is important.') return 40;
            return 2050;
        };
        
        const payload = {
            model: 'auto',
            max_tokens: 256,
            messages: [
                { role: 'system', content: 'System rules here. This is important.' }, // ~8 tokens
                { role: 'user', content: 'First message, very long, a b c d e f g' },
                { role: 'assistant', content: 'Yes, acknowledged' },
                { role: 'user', content: 'Keep this message, it is the last one' }
            ]
        };

        // We bypass actual prediction to just see the router output. Wait, router directly calls predict.
        // We can intercept predict just to inspect the truncated messages.
        let capturedOpts = null;
        defaultAdapter.predict = async (opts) => { capturedOpts = opts; return {}; };

        await router.route(payload);
        
        expect(capturedOpts.messages).to.have.length.lessThan(4);
        expect(capturedOpts.messages[0].role).to.equal('system');
        // The last interaction should be preserved according to our logic
        
        // Restore
        defaultAdapter.getContextWindow = originalGetContextWindow;
        defaultAdapter.countTokens = originalCountTokens;
    });

    it('should trigger compress strategy correctly', async () => {
        const testConfig = {
            ...config,
            compaction: {
                enabled: true,
                minTokensToCompact: 10,
                preserveSystemPrompt: true,
                mode: 'compress',
                targetRatio: 0.3
            }
        };

        const router = new Router(testConfig);
        
        const defaultAdapter = router.adapters.get(router.defaultProvider);
        const originalGetContextWindow = defaultAdapter.getContextWindow.bind(defaultAdapter);
        const originalCountTokens = defaultAdapter.countTokens ? defaultAdapter.countTokens.bind(defaultAdapter) : null;
        defaultAdapter.getContextWindow = async () => 2000;
        defaultAdapter.countTokens = async () => 2050;
        
        let adapterCalled = 0;
        defaultAdapter.predict = async (opts) => {
            adapterCalled++;
            if (adapterCalled === 1) {
                // This is the summary call
                return { choices: [{ message: { content: "Summary of earlier text." } }] };
            } else {
                // This is the final prediction
                return {};
            }
        };

        const payload = {
            model: 'auto',
            max_tokens: 256,
            messages: [
                { role: 'system', content: 'System rules.' },
                { role: 'user', content: 'First very long message that gets compressed.' },
                { role: 'assistant', content: 'Yes, it gets compressed.' },
                { role: 'user', content: 'Second message, keep this' }
            ]
        };

        await router.route(payload);
        
        expect(adapterCalled).to.equal(2);
        
        defaultAdapter.getContextWindow = originalGetContextWindow;
        defaultAdapter.countTokens = originalCountTokens;
    });

    it('should not compact when tokens exceed available but are below minTokensToCompact', async () => {
        const testConfig = {
            ...config,
            compaction: {
                enabled: true,
                minTokensToCompact: 2000,
                preserveSystemPrompt: true,
                preserveLastN: 1,
                mode: 'truncate'
            }
        };

        const router = new Router(testConfig);
        const defaultAdapter = router.adapters.get(router.defaultProvider);
        const originalGetContextWindow = defaultAdapter.getContextWindow.bind(defaultAdapter);
        const originalCountTokens = defaultAdapter.countTokens ? defaultAdapter.countTokens.bind(defaultAdapter) : null;

        defaultAdapter.getContextWindow = async () => 1200;
        defaultAdapter.countTokens = async () => 900;

        let capturedOpts = null;
        defaultAdapter.predict = async (opts) => {
            capturedOpts = opts;
            return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
        };

        const payload = {
            model: 'auto',
            max_tokens: 400,
            messages: [
                { role: 'system', content: 'System rules here.' },
                { role: 'user', content: 'Message one' },
                { role: 'assistant', content: 'Message two' },
                { role: 'user', content: 'Message three' }
            ]
        };

        await router.route(payload);

        expect(capturedOpts.messages).to.have.length(4);

        defaultAdapter.getContextWindow = originalGetContextWindow;
        defaultAdapter.countTokens = originalCountTokens;
    });

    it('should not compact when tokens are above minTokensToCompact but still fit context', async () => {
        const testConfig = {
            ...config,
            compaction: {
                enabled: true,
                minTokensToCompact: 2000,
                preserveSystemPrompt: true,
                preserveLastN: 1,
                mode: 'truncate'
            }
        };

        const router = new Router(testConfig);
        const defaultAdapter = router.adapters.get(router.defaultProvider);
        const originalGetContextWindow = defaultAdapter.getContextWindow.bind(defaultAdapter);
        const originalCountTokens = defaultAdapter.countTokens ? defaultAdapter.countTokens.bind(defaultAdapter) : null;

        defaultAdapter.getContextWindow = async () => 4000;
        defaultAdapter.countTokens = async () => 2500;

        let capturedOpts = null;
        defaultAdapter.predict = async (opts) => {
            capturedOpts = opts;
            return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
        };

        const payload = {
            model: 'auto',
            max_tokens: 500,
            messages: [
                { role: 'system', content: 'System rules here.' },
                { role: 'user', content: 'Message one' },
                { role: 'assistant', content: 'Message two' },
                { role: 'user', content: 'Message three' }
            ]
        };

        await router.route(payload);

        expect(capturedOpts.messages).to.have.length(4);

        defaultAdapter.getContextWindow = originalGetContextWindow;
        defaultAdapter.countTokens = originalCountTokens;
    });

    it('should honor per-request context_strategy mode none with 413 when over context', async () => {
        const testConfig = {
            ...config,
            compaction: {
                enabled: true,
                minTokensToCompact: 10,
                preserveSystemPrompt: true,
                preserveLastN: 1,
                mode: 'truncate'
            }
        };

        const router = new Router(testConfig);
        const defaultAdapter = router.adapters.get(router.defaultProvider);
        const originalGetContextWindow = defaultAdapter.getContextWindow.bind(defaultAdapter);
        const originalCountTokens = defaultAdapter.countTokens ? defaultAdapter.countTokens.bind(defaultAdapter) : null;

        defaultAdapter.getContextWindow = async () => 1200;
        defaultAdapter.countTokens = async () => 1000;

        const payload = {
            model: 'auto',
            max_tokens: 300,
            context_strategy: { mode: 'none' },
            messages: [
                { role: 'user', content: 'Message one' },
                { role: 'assistant', content: 'Message two' },
                { role: 'user', content: 'Message three' }
            ]
        };

        let err;
        try {
            await router.route(payload);
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.status).to.equal(413);

        defaultAdapter.getContextWindow = originalGetContextWindow;
        defaultAdapter.countTokens = originalCountTokens;
    });

    it('should honor per-request context_strategy truncate overriding global none', async () => {
        const testConfig = {
            ...config,
            compaction: {
                enabled: true,
                minTokensToCompact: 10,
                preserveSystemPrompt: true,
                preserveLastN: 1,
                mode: 'none'
            }
        };

        const router = new Router(testConfig);
        const defaultAdapter = router.adapters.get(router.defaultProvider);
        const originalGetContextWindow = defaultAdapter.getContextWindow.bind(defaultAdapter);
        const originalCountTokens = defaultAdapter.countTokens ? defaultAdapter.countTokens.bind(defaultAdapter) : null;

        defaultAdapter.getContextWindow = async () => 2000;
        defaultAdapter.countTokens = async (text) => {
            if (text === 'System rules here.') return 40;
            return 2050;
        };

        let capturedOpts = null;
        defaultAdapter.predict = async (opts) => {
            capturedOpts = opts;
            return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
        };

        const payload = {
            model: 'auto',
            max_tokens: 256,
            context_strategy: {
                mode: 'truncate',
                preserve_recent: 1
            },
            messages: [
                { role: 'system', content: 'System rules here.' },
                { role: 'user', content: 'First very long message' },
                { role: 'assistant', content: 'Acknowledged' },
                { role: 'user', content: 'Keep this message' }
            ]
        };

        await router.route(payload);

        expect(capturedOpts.messages).to.have.length.lessThan(4);
        expect(capturedOpts.messages[0].role).to.equal('system');

        defaultAdapter.getContextWindow = originalGetContextWindow;
        defaultAdapter.countTokens = originalCountTokens;
    });

    it('should attach context metadata in non-streaming response', async () => {
        const testConfig = {
            ...config,
            compaction: {
                enabled: true,
                minTokensToCompact: 10,
                preserveSystemPrompt: true,
                preserveLastN: 1,
                mode: 'truncate'
            }
        };

        const router = new Router(testConfig);
        const defaultAdapter = router.adapters.get(router.defaultProvider);
        const originalGetContextWindow = defaultAdapter.getContextWindow.bind(defaultAdapter);
        const originalCountTokens = defaultAdapter.countTokens ? defaultAdapter.countTokens.bind(defaultAdapter) : null;

        defaultAdapter.getContextWindow = async () => 2000;
        defaultAdapter.countTokens = async () => 200;
        defaultAdapter.predict = async () => ({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        });

        const payload = {
            model: 'auto',
            max_tokens: 256,
            messages: [
                { role: 'user', content: 'small prompt' }
            ]
        };

        const result = await router.route(payload);

        expect(result.context).to.exist;
        expect(result.context).to.have.property('window_size', 2000);
        expect(result.context).to.have.property('used_tokens');
        expect(result.context).to.have.property('available_tokens');
        expect(result.context).to.have.property('strategy_applied', false);

        defaultAdapter.getContextWindow = originalGetContextWindow;
        defaultAdapter.countTokens = originalCountTokens;
    });

    it('should return accepted async ticket when X-Async is true and compaction is needed', async () => {
        const testConfig = {
            ...config,
            compaction: {
                enabled: true,
                minTokensToCompact: 10,
                preserveSystemPrompt: true,
                preserveLastN: 1,
                mode: 'truncate'
            }
        };

        const ticketRegistry = new TicketRegistry();
        const router = new Router(testConfig, null, ticketRegistry);
        const defaultAdapter = router.adapters.get(router.defaultProvider);
        const originalGetContextWindow = defaultAdapter.getContextWindow.bind(defaultAdapter);
        const originalCountTokens = defaultAdapter.countTokens ? defaultAdapter.countTokens.bind(defaultAdapter) : null;

        defaultAdapter.getContextWindow = async () => 1200;
        defaultAdapter.countTokens = async () => 1200;
        defaultAdapter.predict = async () => ({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        });

        const payload = {
            model: 'auto',
            max_tokens: 300,
            messages: [
                { role: 'user', content: 'message one' },
                { role: 'assistant', content: 'message two' },
                { role: 'user', content: 'message three' }
            ]
        };

        const result = await router.route(payload, { 'x-async': 'true' });

        expect(result.isAsyncTicket).to.equal(true);
        expect(result.ticketData).to.have.property('object', 'chat.completion.task');
        expect(result.ticketData).to.have.property('status', 'accepted');
        expect(result.ticketData).to.have.property('ticket');

        defaultAdapter.getContextWindow = originalGetContextWindow;
        defaultAdapter.countTokens = originalCountTokens;
    });
});
