/**
 * Multi-Provider Vision Test Suite
 * Tests vision capabilities across all configured providers
 * 
 * Usage:
 *   node test_vision_all_providers.mjs [provider]
 * 
 * Examples:
 *   node test_vision_all_providers.mjs           # Test all providers
 *   node test_vision_all_providers.mjs gemini    # Test only Gemini
 *   node test_vision_all_providers.mjs openai    # Test only OpenAI
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
    // 1x1 red pixel PNG
    redPixel: {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
        mimeType: 'image/png',
        description: 'red',
        get dataUrl() { return `data:${this.mimeType};base64,${this.base64}`; }
    },
    // 1x1 blue pixel PNG
    bluePixel: {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
        mimeType: 'image/png',
        description: 'blue',
        get dataUrl() { return `data:${this.mimeType};base64,${this.base64}`; }
    },
    // 1x1 green pixel PNG
    greenPixel: {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
        mimeType: 'image/png',
        description: 'green',
        get dataUrl() { return `data:${this.mimeType};base64,${this.base64}`; }
    }
};

// Remote test image (Google logo - reliable)
const REMOTE_IMAGE_URL = 'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png';

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
// Provider Configurations
// ==========================================
const PROVIDER_CONFIGS = {
    gemini: {
        model: 'gemini-2.0-flash',
        supportsVision: true,
        description: 'Google Gemini'
    },
    openai: {
        model: 'gpt-4o-mini',
        supportsVision: true,
        description: 'OpenAI GPT-4o'
    },
    grok: {
        model: 'grok-2-vision-latest',
        supportsVision: true,
        description: 'xAI Grok'
    },
    lmstudio: {
        model: 'auto',
        supportsVision: true,
        description: 'LM Studio (local)'
    },
    ollama: {
        model: 'llava',
        supportsVision: true,
        description: 'Ollama (local)'
    }
};

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
// TEST: Base64 Data URL Vision
// ==========================================
async function testBase64Vision(provider, config) {
    log(`${provider.toUpperCase()}`, `Testing Base64 Data URL Vision`, 'info');
    
    const payload = {
        model: config.model,
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
        const result = await gatewayChatCompletion(payload, provider);
        const latency = Date.now() - startTime;
        
        const response = result.choices?.[0]?.message?.content || '';
        log(`${provider.toUpperCase()}`, `Response: "${response}" (${latency}ms)`, 'info');
        
        const isCorrect = response.toLowerCase().includes('red') || 
                         response.toLowerCase().includes('pixel');
        
        if (isCorrect) {
            log(`${provider.toUpperCase()}`, '✓ Base64 vision working', 'success');
            return { success: true, latency, response };
        } else {
            log(`${provider.toUpperCase()}`, '⚠ Request succeeded but color not detected', 'warn');
            return { success: true, latency, response, warning: 'Color not detected' };
        }
    } catch (err) {
        log(`${provider.toUpperCase()}`, `✗ Base64 vision failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST: Remote Image URL Vision
// ==========================================
async function testRemoteUrlVision(provider, config) {
    log(`${provider.toUpperCase()}`, `Testing Remote URL Vision`, 'info');
    
    const payload = {
        model: config.model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What company logo is this? Answer briefly.' },
                    { type: 'image_url', image_url: { url: REMOTE_IMAGE_URL } }
                ]
            }
        ]
    };
    
    try {
        const startTime = Date.now();
        const result = await gatewayChatCompletion(payload, provider);
        const latency = Date.now() - startTime;
        
        const response = result.choices?.[0]?.message?.content || '';
        log(`${provider.toUpperCase()}`, `Response: "${response.substring(0, 60)}${response.length > 60 ? '...' : ''}" (${latency}ms)`, 'info');
        
        // Check if response indicates image was seen
        const cantSeeIndicators = ["i can't see", "cannot see", "unable to see", "no image", "image not"];
        const canSee = !cantSeeIndicators.some(ind => response.toLowerCase().includes(ind));
        
        if (canSee) {
            log(`${provider.toUpperCase()}`, '✓ Remote URL vision working', 'success');
        } else {
            log(`${provider.toUpperCase()}`, '⚠ Model may not have received the image', 'warn');
        }
        
        return { success: true, latency, response, canSee };
    } catch (err) {
        log(`${provider.toUpperCase()}`, `✗ Remote URL vision failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST: Multiple Images
// ==========================================
async function testMultipleImages(provider, config) {
    log(`${provider.toUpperCase()}`, `Testing Multiple Images`, 'info');
    
    const payload = {
        model: config.model,
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
        const result = await gatewayChatCompletion(payload, provider);
        const latency = Date.now() - startTime;
        
        const response = result.choices?.[0]?.message?.content || '';
        log(`${provider.toUpperCase()}`, `Response: "${response}" (${latency}ms)`, 'info');
        
        const mentionsBoth = (response.toLowerCase().includes('red') && response.toLowerCase().includes('blue')) ||
                              response.toLowerCase().includes('two');
        
        if (mentionsBoth) {
            log(`${provider.toUpperCase()}`, '✓ Multiple images working', 'success');
        } else {
            log(`${provider.toUpperCase()}`, '⚠ May not have processed both images', 'warn');
        }
        
        return { success: true, latency, response, mentionsBoth };
    } catch (err) {
        log(`${provider.toUpperCase()}`, `✗ Multiple images failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST: Detail Parameter
// ==========================================
async function testDetailParameter(provider, config) {
    log(`${provider.toUpperCase()}`, `Testing Detail Parameter`, 'info');
    
    const details = ['auto', 'low'];
    const results = {};
    
    for (const detail of details) {
        const payload = {
            model: config.model,
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
            const result = await gatewayChatCompletion(payload, provider);
            const latency = Date.now() - startTime;
            
            const response = result.choices?.[0]?.message?.content || '';
            results[detail] = { success: true, latency, response };
        } catch (err) {
            results[detail] = { success: false, error: err.message };
        }
    }
    
    const allSuccess = Object.values(results).every(r => r.success);
    if (allSuccess) {
        log(`${provider.toUpperCase()}`, `✓ Detail parameter working (${Object.keys(results).join(', ')})`, 'success');
    } else {
        log(`${provider.toUpperCase()}`, `✗ Detail parameter failed`, 'error');
    }
    
    return { success: allSuccess, results };
}

// ==========================================
// Check Provider Availability
// ==========================================
async function checkProviderAvailable(provider) {
    try {
        const res = await fetch(`${GATEWAY_URL}/v1/models`, {
            headers: { 'X-Provider': provider }
        });
        
        if (!res.ok) return false;
        
        const data = await res.json();
        const models = data.data || [];
        return models.length > 0;
    } catch (err) {
        return false;
    }
}

// ==========================================
// Get Vision Models for Provider
// ==========================================
async function getVisionModels(provider) {
    try {
        const res = await fetch(`${GATEWAY_URL}/v1/models`, {
            headers: { 'X-Provider': provider }
        });
        
        if (!res.ok) return [];
        
        const data = await res.json();
        const models = data.data || [];
        return models.filter(m => m.capabilities?.vision === true);
    } catch (err) {
        return [];
    }
}

// ==========================================
// Run Tests for Single Provider
// ==========================================
async function runProviderTests(provider, config) {
    console.log(`\n${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}  Testing: ${config.description}${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    
    // Check if provider is available
    const isAvailable = await checkProviderAvailable(provider);
    if (!isAvailable) {
        log(`${provider.toUpperCase()}`, 'Provider not available (skipped)', 'warn');
        return { available: false, skipped: true };
    }
    
    // Get vision models
    const visionModels = await getVisionModels(provider);
    log(`${provider.toUpperCase()}`, `${visionModels.length} vision-capable models found`, 'info');
    
    if (visionModels.length > 0 && config.model === 'auto') {
        // Use first available vision model
        config.model = visionModels[0].id;
        log(`${provider.toUpperCase()}`, `Using model: ${config.model}`, 'info');
    }
    
    const results = {
        available: true,
        visionModels: visionModels.length,
        tests: {}
    };
    
    // Run tests
    results.tests.base64 = await testBase64Vision(provider, config);
    results.tests.remoteUrl = await testRemoteUrlVision(provider, config);
    results.tests.multipleImages = await testMultipleImages(provider, config);
    results.tests.detailParam = await testDetailParameter(provider, config);
    
    // Summary
    const allPassed = Object.values(results.tests).every(t => t.success);
    results.allPassed = allPassed;
    
    if (allPassed) {
        log(`${provider.toUpperCase()}`, '✓ All tests passed', 'success');
    } else {
        log(`${provider.toUpperCase()}`, '✗ Some tests failed', 'error');
    }
    
    return results;
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    const specificProvider = process.argv[2];
    
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}   Multi-Provider Vision Test Suite      ${colors.reset}`);
    console.log(`${colors.blue}   Gateway: ${GATEWAY_URL}${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    // Check gateway health
    try {
        const healthCheck = await fetch(`${GATEWAY_URL}/health`);
        if (!healthCheck.ok) throw new Error('Health check failed');
        log('SETUP', 'Gateway is reachable', 'success');
    } catch (err) {
        log('SETUP', `Gateway not reachable at ${GATEWAY_URL}`, 'error');
        process.exit(1);
    }
    
    // Determine which providers to test
    let providersToTest;
    if (specificProvider) {
        if (!PROVIDER_CONFIGS[specificProvider]) {
            log('SETUP', `Unknown provider: ${specificProvider}`, 'error');
            console.log('Available providers:', Object.keys(PROVIDER_CONFIGS).join(', '));
            process.exit(1);
        }
        providersToTest = { [specificProvider]: PROVIDER_CONFIGS[specificProvider] };
    } else {
        providersToTest = PROVIDER_CONFIGS;
    }
    
    // Run tests for each provider
    const allResults = {};
    for (const [provider, config] of Object.entries(providersToTest)) {
        allResults[provider] = await runProviderTests(provider, config);
    }
    
    // Final Summary
    console.log(`\n${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}              FINAL SUMMARY             ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    
    for (const [provider, result] of Object.entries(allResults)) {
        if (result.skipped) {
            console.log(`${colors.yellow}⏭ ${provider}: Skipped (not available)${colors.reset}`);
            totalSkipped++;
        } else if (result.allPassed) {
            console.log(`${colors.green}✓ ${provider}: All tests passed${colors.reset}`);
            totalPassed++;
        } else {
            console.log(`${colors.red}✗ ${provider}: Some tests failed${colors.reset}`);
            totalFailed++;
        }
    }
    
    console.log(`\n${colors.blue}Total: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped${colors.reset}`);
    
    // Save results
    const resultsPath = path.join(__dirname, 'output', 'vision_all_providers_results.json');
    if (!fs.existsSync(path.dirname(resultsPath))) {
        fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    }
    fs.writeFileSync(resultsPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        gateway: GATEWAY_URL,
        results: allResults
    }, null, 2));
    log('SAVE', `Results saved to: ${resultsPath}`, 'info');
    
    process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
    log('FATAL', err.message, 'error');
    process.exit(1);
});
