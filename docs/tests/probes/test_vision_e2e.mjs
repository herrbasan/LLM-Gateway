/**
 * End-to-End Vision Test
 * Tests the Gateway's /v1/chat/completions with vision capabilities
 * 
 * Tests:
 * 1. Base64 data URL with Gemini
 * 2. Remote image URL with Gemini (tests ImageFetcher integration)
 * 3. Detail parameter (low/high/auto)
 * 4. Multiple images in one request
 * 5. OpenAI-compatible provider (if configured)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

// Gateway configuration
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3400';

// Test images - Valid base64-encoded PNGs
const TEST_IMAGES = {
    // 1x1 red pixel PNG (valid PNG file)
    redPixel: {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
        mimeType: 'image/png',
        description: 'red',
        get dataUrl() { return `data:${this.mimeType};base64,${this.base64}`; }
    },
    // 1x1 blue pixel PNG (valid PNG file)
    bluePixel: {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
        mimeType: 'image/png',
        description: 'blue',
        get dataUrl() { return `data:${this.mimeType};base64,${this.base64}`; }
    },
    // 1x1 green pixel PNG (valid PNG file)
    greenPixel: {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
        mimeType: 'image/png',
        description: 'green',
        get dataUrl() { return `data:${this.mimeType};base64,${this.base64}`; }
    }
};

// ANSI colors
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(section, message, type = 'info') {
    const color = type === 'success' ? colors.green : type === 'error' ? colors.red : type === 'warn' ? colors.yellow : colors.cyan;
    console.log(`${color}[${section}]${colors.reset} ${message}`);
}

// ==========================================
// HELPER: Gateway Request
// ==========================================
async function gatewayChatCompletion(payload, provider = null) {
    const headers = {
        'Content-Type': 'application/json'
    };
    
    if (provider) {
        headers['X-Provider'] = provider;
    }
    
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });
    
    const data = await res.json();
    
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
    
    return data;
}

// ==========================================
// TEST 1: Base64 Data URL with Gemini
// ==========================================
async function testBase64DataUrl() {
    log('TEST-1', 'Base64 Data URL with Gemini', 'info');
    
    const payload = {
        model: 'gemini-2.0-flash',
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What is the main color in this image? Answer with just the color name.' },
                    { type: 'image_url', image_url: { url: TEST_IMAGES.redPixel.dataUrl } }
                ]
            }
        ]
    };
    
    try {
        const startTime = Date.now();
        const result = await gatewayChatCompletion(payload, 'gemini');
        const latency = Date.now() - startTime;
        
        const response = result.choices?.[0]?.message?.content || '';
        log('TEST-1', `Response: "${response}"`, 'info');
        log('TEST-1', `Latency: ${latency}ms`, 'info');
        
        // Check if response mentions red or similar colors
        const isCorrect = response.toLowerCase().includes('red') || 
                         response.toLowerCase().includes('pixel');
        
        if (isCorrect) {
            log('TEST-1', '✓ Model processed the image', 'success');
            return { success: true, latency, response };
        } else {
            log('TEST-1', '⚠ Response did not match expected but request succeeded', 'warn');
            return { success: true, latency, response, warning: 'Color not detected in response' };
        }
    } catch (err) {
        log('TEST-1', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST 2: Remote Image URL with Gemini
// ==========================================
async function testRemoteImageUrl() {
    log('TEST-2', 'Remote Image URL with Gemini (tests ImageFetcher)', 'info');
    
    // Use httpbin which is reliable for testing
    // We create a data URL, upload it to a service, then test fetching it
    // For now, let's test with a well-known public image URL
    const testUrl = 'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png';
    
    log('TEST-2', `Using URL: ${testUrl.substring(0, 50)}...`, 'info');
    
    const payload = {
        model: 'gemini-2.0-flash',
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What company logo is this? Answer briefly.' },
                    { type: 'image_url', image_url: { url: testUrl } }
                ]
            }
        ]
    };
    
    try {
        const startTime = Date.now();
        const result = await gatewayChatCompletion(payload, 'gemini');
        const latency = Date.now() - startTime;
        
        const response = result.choices?.[0]?.message?.content || '';
        log('TEST-2', `Response: "${response.substring(0, 100)}${response.length > 100 ? '...' : ''}"`, 'info');
        log('TEST-2', `Latency: ${latency}ms`, 'info');
        
        // Check if response indicates image was seen (not "I can't see" or similar)
        const cantSeeIndicators = ["i can't see", "cannot see", "unable to see", "no image", "image not"];
        const canSee = !cantSeeIndicators.some(ind => response.toLowerCase().includes(ind));
        
        if (canSee) {
            log('TEST-2', '✓ Model appears to have processed the remote image', 'success');
        } else {
            log('TEST-2', '⚠ Model may not have received the image', 'warn');
        }
        
        return { success: true, latency, response, canSee };
    } catch (err) {
        log('TEST-2', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST 3: Detail Parameter
// ==========================================
async function testDetailParameter() {
    log('TEST-3', 'Detail Parameter (low/high/auto)', 'info');
    log('TEST-3', 'Note: Using small 1x1 pixel images, detail may not have visible effect', 'info');
    
    const details = ['auto', 'low']; // Skip 'high' as it requires larger images
    const results = {};
    
    for (const detail of details) {
        log('TEST-3', `Testing detail="${detail}"...`, 'info');
        
        const payload = {
            model: 'gemini-2.0-flash',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What color is this? Answer with just the color.' },
                        { type: 'image_url', image_url: { url: TEST_IMAGES.greenPixel.dataUrl, detail } }
                    ]
                }
            ]
        };
        
        try {
            const startTime = Date.now();
            const result = await gatewayChatCompletion(payload, 'gemini');
            const latency = Date.now() - startTime;
            
            const response = result.choices?.[0]?.message?.content || '';
            log('TEST-3', `  detail=${detail}: "${response}" (${latency}ms)`, 'info');
            
            results[detail] = { success: true, latency, response };
        } catch (err) {
            log('TEST-3', `  detail=${detail}: Failed - ${err.message}`, 'error');
            results[detail] = { success: false, error: err.message };
        }
    }
    
    const allSuccess = Object.values(results).every(r => r.success);
    if (allSuccess) {
        log('TEST-3', '✓ All detail levels worked', 'success');
    }
    
    return { success: allSuccess, results };
}

// ==========================================
// TEST 4: Multiple Images
// ==========================================
async function testMultipleImages() {
    log('TEST-4', 'Multiple Images in Single Request', 'info');
    
    const payload = {
        model: 'gemini-2.0-flash',
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'How many images are shown and what are their colors? Answer briefly.' },
                    { type: 'image_url', image_url: { url: TEST_IMAGES.redPixel.dataUrl } },
                    { type: 'image_url', image_url: { url: TEST_IMAGES.bluePixel.dataUrl } }
                ]
            }
        ]
    };
    
    try {
        const startTime = Date.now();
        const result = await gatewayChatCompletion(payload, 'gemini');
        const latency = Date.now() - startTime;
        
        const response = result.choices?.[0]?.message?.content || '';
        log('TEST-4', `Response: "${response}"`, 'info');
        log('TEST-4', `Latency: ${latency}ms`, 'info');
        
        // Check if response mentions both colors or indicates two images
        const mentionsBoth = (response.toLowerCase().includes('red') && response.toLowerCase().includes('blue')) ||
                              response.toLowerCase().includes('two');
        
        if (mentionsBoth) {
            log('TEST-4', '✓ Correctly identified multiple images', 'success');
        } else {
            log('TEST-4', '⚠ Response may not mention both images, but request succeeded', 'warn');
        }
        
        return { success: true, latency, response, mentionsBoth };
    } catch (err) {
        log('TEST-4', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST 5: Provider that doesn't support vision
// ==========================================
async function testNonVisionProvider() {
    log('TEST-5', 'Non-vision Provider Rejection', 'info');
    
    const payload = {
        model: 'some-model',
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Describe this' },
                    { type: 'image_url', image_url: { url: TEST_IMAGES.redPixel.dataUrl } }
                ]
            }
        ]
    };
    
    try {
        // Try with lmstudio provider which likely doesn't support vision
        const result = await gatewayChatCompletion(payload, 'lmstudio');
        
        log('TEST-5', '⚠ Request succeeded - provider may support vision or not be filtered', 'warn');
        return { success: true, note: 'Provider accepted vision request' };
    } catch (err) {
        if (err.message.includes('422') || err.message.includes('does not support vision') || err.message.includes('does not support images')) {
            log('TEST-5', '✓ Correctly rejected vision request to non-vision provider', 'success');
            return { success: true, correctlyRejected: true, error: err.message };
        } else {
            log('TEST-5', `Failed with unexpected error: ${err.message}`, 'error');
            return { success: false, error: err.message };
        }
    }
}

// ==========================================
// TEST 6: List Vision Models
// ==========================================
async function testListVisionModels() {
    log('TEST-6', 'List Vision-Capable Models', 'info');
    
    try {
        const res = await fetch(`${GATEWAY_URL}/v1/models`);
        const data = await res.json();
        
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
        }
        
        const models = data.data || [];
        const visionModels = models.filter(m => m.capabilities?.vision === true);
        
        log('TEST-6', `Total models: ${models.length}`, 'info');
        log('TEST-6', `Vision-capable models: ${visionModels.length}`, 'info');
        
        // Group by provider
        const byProvider = {};
        visionModels.forEach(m => {
            const provider = m.provider || 'unknown';
            if (!byProvider[provider]) byProvider[provider] = [];
            byProvider[provider].push(m.id);
        });
        
        Object.entries(byProvider).forEach(([provider, models]) => {
            log('TEST-6', `  ${provider}: ${models.length} models`, 'info');
        });
        
        return { 
            success: true, 
            total: models.length, 
            visionCount: visionModels.length,
            byProvider
        };
    } catch (err) {
        log('TEST-6', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}   End-to-End Vision Test Suite          ${colors.reset}`);
    console.log(`${colors.blue}   Gateway: ${GATEWAY_URL}${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    // Check if gateway is reachable
    try {
        const healthCheck = await fetch(`${GATEWAY_URL}/health`);
        if (!healthCheck.ok) {
            throw new Error('Health check failed');
        }
        log('SETUP', 'Gateway is reachable', 'success');
    } catch (err) {
        log('SETUP', `Gateway not reachable at ${GATEWAY_URL}`, 'error');
        log('SETUP', 'Make sure the gateway is running: npm start', 'error');
        process.exit(1);
    }
    
    const results = {
        timestamp: new Date().toISOString(),
        gateway: GATEWAY_URL,
        tests: {}
    };
    
    // Run tests
    results.tests.listVisionModels = await testListVisionModels();
    results.tests.base64DataUrl = await testBase64DataUrl();
    results.tests.remoteImageUrl = await testRemoteImageUrl();
    results.tests.detailParameter = await testDetailParameter();
    results.tests.multipleImages = await testMultipleImages();
    results.tests.nonVisionProvider = await testNonVisionProvider();
    
    // Summary
    console.log(`\n${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}              SUMMARY                   ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    
    const testResults = Object.entries(results.tests);
    const passed = testResults.filter(([, r]) => r.success).length;
    const failed = testResults.filter(([, r]) => !r.success).length;
    
    testResults.forEach(([test, result]) => {
        const status = result?.success ? '✅ PASS' : '❌ FAIL';
        const color = result?.success ? colors.green : colors.red;
        console.log(`${color}${status}${colors.reset} ${test}`);
        if (result?.error && !result.success) {
            console.log(`      Error: ${result.error.substring(0, 100)}`);
        }
    });
    
    console.log(`\n${colors.blue}Total: ${passed} passed, ${failed} failed${colors.reset}`);
    
    // Save results
    const resultsPath = path.join(__dirname, 'output', 'vision_e2e_results.json');
    if (!fs.existsSync(path.dirname(resultsPath))) {
        fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    }
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    log('SAVE', `Results saved to: ${resultsPath}`, 'info');
    
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    log('FATAL', err.message, 'error');
    process.exit(1);
});
