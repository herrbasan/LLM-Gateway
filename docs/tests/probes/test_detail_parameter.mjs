/**
 * Test Detail Parameter Support
 * Verifies that detail: low|high|auto is correctly handled
 */
import { TokenEstimator } from '../../../src/context/estimator.js';

async function runTests() {
    console.log('=== Detail Parameter Tests ===\n');

    const estimator = new TokenEstimator({});

    // Test 1: Default token cost (no detail specified = auto = low)
    console.log('Test 1: Default token cost (no detail)');
    const defaultContent = [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } }
    ];
    const defaultTokens = await estimator.estimate(defaultContent, null, 'gpt-4');
    console.log(`  Tokens: ${defaultTokens} (expected ~85 for text + 85 for image = ~90)`);
    if (defaultTokens >= 85 && defaultTokens < 200) {
        console.log('  OK: Default uses low-res cost');
    } else {
        console.log('  FAIL: Unexpected token count');
    }

    // Test 2: Explicit low detail
    console.log('\nTest 2: Explicit detail=low');
    const lowContent = [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ', detail: 'low' } }
    ];
    const lowTokens = await estimator.estimate(lowContent, null, 'gpt-4');
    console.log(`  Tokens: ${lowTokens} (expected ~90)`);
    if (lowTokens >= 85 && lowTokens < 200) {
        console.log('  OK: detail=low uses low-res cost');
    } else {
        console.log('  FAIL: Unexpected token count');
    }

    // Test 3: High detail
    console.log('\nTest 3: Explicit detail=high');
    const highContent = [
        { type: 'text', text: 'Describe this image in detail' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ', detail: 'high' } }
    ];
    const highTokens = await estimator.estimate(highContent, null, 'gpt-4');
    console.log(`  Tokens: ${highTokens} (expected ~260, text + 255 for high-res)`);
    if (highTokens >= 200) {
        console.log('  OK: detail=high uses high-res cost');
    } else {
        console.log('  FAIL: Unexpected token count');
    }

    // Test 4: Multiple images with mixed detail
    console.log('\nTest 4: Multiple images with mixed detail');
    const mixedContent = [
        { type: 'text', text: 'Compare these images' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ1', detail: 'low' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ2', detail: 'high' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ3' } } // auto = low
    ];
    const mixedTokens = await estimator.estimate(mixedContent, null, 'gpt-4');
    console.log(`  Tokens: ${mixedTokens} (expected ~430, text + 85 + 255 + 85)`);
    if (mixedTokens >= 350) {
        console.log('  OK: Mixed detail levels calculated correctly');
    } else {
        console.log('  FAIL: Unexpected token count');
    }

    // Test 5: Verify MediaProcessorClient accepts detail parameter
    console.log('\nTest 5: MediaProcessorClient detail parameter');
    try {
        const { MediaProcessorClient } = await import('../../../src/utils/media-client.js');
        const client = new MediaProcessorClient({ mediaProcessor: { enabled: false } });
        
        // Since MediaProcessor is disabled, it should return base64 unchanged
        const testBase64 = 'dGVzdA==';
        const result = await client.optimizeImage(testBase64, 'image/jpeg', 'low');
        if (result === testBase64) {
            console.log('  OK: MediaProcessorClient accepts detail parameter');
        } else {
            console.log('  FAIL: Unexpected result');
        }
    } catch (e) {
        console.log(`  FAIL: ${e.message}`);
    }

    console.log('\n=== Detail Parameter Tests Complete ===');
}

runTests().catch(console.error);
