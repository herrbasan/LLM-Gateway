import { expect } from 'chai';
import { Router } from '../src/core/router.js';
import { loadConfig } from '../src/config.js';
import { TokenEstimator } from '../src/context/estimator.js';
import { ContextManager } from '../src/context/strategy.js';

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
        
        // Mock the adapter's getContextWindow so we trigger truncate
        const defaultAdapter = router.adapters.get(router.defaultProvider);
        const originalGetContextWindow = defaultAdapter.getContextWindow.bind(defaultAdapter);
        defaultAdapter.getContextWindow = async () => 50; // VERY low
        
        const payload = {
            model: 'auto',
            max_tokens: 10,
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
        defaultAdapter.getContextWindow = async () => 50;
        
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
            max_tokens: 10,
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
    });
});
