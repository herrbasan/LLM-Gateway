/**
 * Grok Comprehensive Multimodal Test Suite
 * Tests: Vision, Image Generation, TTS (if available)
 * 
 * Provider: xAI Grok
 * Docs: https://docs.x.ai/developers/introduction
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const API_KEY = process.env.GROK_API_KEY;
const ENDPOINT = 'https://api.x.ai/v1';
const OUTPUT_DIR = path.join(__dirname, 'output', 'grok');

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const colors = {
    reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m'
};

function log(section, message, type = 'info') {
    const color = type === 'success' ? colors.green : type === 'error' ? colors.red : type === 'warn' ? colors.yellow : type === 'section' ? colors.blue : colors.cyan;
    console.log(`${color}[${section}]${colors.reset} ${message}`);
}

function logSection(title) {
    console.log(`\n${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}  ${title}${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
}

// ==========================================
// TEST 1: VISION - Image Input Analysis
// ==========================================
async function testVision() {
    logSection('VISION - Image Input Analysis');
    
    const results = { capability: 'Vision', tested: false, passed: false, tests: [] };
    
    // Test with different Grok models
    const testCases = [
        { name: 'grok-3 vision test', model: 'grok-3' },
        { name: 'grok-4 vision test', model: 'grok-4-fast-non-reasoning' }
    ];
    
    // Small test image
    const testImageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpi2r9//38gYGAEESAAEGAAasgJOgzOKCoAAAAASUVORK5CYII=';
    
    for (const testCase of testCases) {
        log('TEST', `Testing: ${testCase.name}`, 'section');
        
        try {
            const body = {
                model: testCase.model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'What color is this image? Answer with just the color.' },
                            { type: 'image_url', image_url: { url: `data:image/png;base64,${testImageB64}` } }
                        ]
                    }
                ]
            };
            
            const startTime = Date.now();
            const res = await fetch(`${ENDPOINT}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
                body: JSON.stringify(body)
            });
            const latency = Date.now() - startTime;
            
            const data = await res.json();
            
            if (data.error) {
                const errMsg = data.error.message || JSON.stringify(data.error);
                log('FAIL', `Error: ${errMsg.substring(0, 100)}`, 'error');
                results.tests.push({
                    name: testCase.name, model: testCase.model,
                    passed: false, error: errMsg, latency
                });
            } else {
                const text = data.choices?.[0]?.message?.content || '';
                log('PASS', `Response (${latency}ms): "${text.substring(0, 100)}"`, 'success');
                results.tests.push({
                    name: testCase.name, model: testCase.model,
                    passed: true, response: text, latency
                });
            }
        } catch (err) {
            log('FAIL', `Exception: ${err.message}`, 'error');
            results.tests.push({
                name: testCase.name, model: testCase.model,
                passed: false, error: err.message
            });
        }
    }
    
    results.tested = true;
    results.passed = results.tests.some(t => t.passed);
    return results;
}

// ==========================================
// TEST 2: IMAGE GENERATION
// ==========================================
async function testImageGeneration() {
    logSection('IMAGE GENERATION');
    
    const results = { capability: 'Image Generation', tested: false, passed: false, tests: [] };
    
    const testCases = [
        { name: 'Standard image generation', model: 'grok-imagine-image' },
        { name: 'Pro image generation', model: 'grok-imagine-image-pro' }
    ];
    
    for (const testCase of testCases) {
        log('TEST', `Testing: ${testCase.name} (${testCase.model})`, 'section');
        
        try {
            const body = {
                model: testCase.model,
                prompt: 'A futuristic city skyline at sunset with flying cars and neon lights',
                n: 1
            };
            
            const startTime = Date.now();
            const res = await fetch(`${ENDPOINT}/images/generations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
                body: JSON.stringify(body)
            });
            const latency = Date.now() - startTime;
            
            const data = await res.json();
            
            if (data.error) {
                log('FAIL', `Error: ${JSON.stringify(data.error)}`, 'error');
                results.tests.push({
                    name: testCase.name, model: testCase.model,
                    passed: false, error: data.error, latency
                });
            } else {
                const images = data.data || [];
                if (images.length === 0 || !images[0].url) {
                    log('FAIL', 'No image URL in response', 'error');
                    results.tests.push({
                        name: testCase.name, model: testCase.model,
                        passed: false, error: 'No image URL'
                    });
                    continue;
                }
                
                const imageUrl = images[0].url;
                log('INFO', `Image URL: ${imageUrl.substring(0, 80)}...`, 'info');
                
                // Fetch the actual image
                const imgRes = await fetch(imageUrl);
                const buffer = Buffer.from(await imgRes.arrayBuffer());
                
                const outputPath = path.join(OUTPUT_DIR, `${testCase.model.replace(/[^a-z0-9]/gi, '_')}.png`);
                fs.writeFileSync(outputPath, buffer);
                
                log('PASS', `Downloaded ${buffer.byteLength} bytes (${latency}ms)`, 'success');
                log('INFO', `Saved to: ${outputPath}`, 'info');
                
                // Log billing info if available
                if (data.usage?.cost_in_usd_ticks) {
                    log('INFO', `Cost: ${data.usage.cost_in_usd_ticks} USD ticks`, 'info');
                }
                
                results.tests.push({
                    name: testCase.name, model: testCase.model,
                    passed: true, size: buffer.byteLength, latency, outputPath
                });
            }
        } catch (err) {
            log('FAIL', `Exception: ${err.message}`, 'error');
            results.tests.push({
                name: testCase.name, model: testCase.model,
                passed: false, error: err.message
            });
        }
    }
    
    results.tested = true;
    results.passed = results.tests.some(t => t.passed);
    return results;
}

// ==========================================
// TEST 3: TEXT-TO-SPEECH
// ==========================================
async function testTTS() {
    logSection('TEXT-TO-SPEECH');
    
    const results = { capability: 'Text-to-Speech', tested: false, passed: false, tests: [] };
    
    log('INFO', 'Testing TTS endpoint availability...', 'info');
    
    try {
        const body = {
            model: 'tts-1',
            input: 'Hello from Grok text to speech test.',
            voice: 'alloy',
            response_format: 'mp3'
        };
        
        const res = await fetch(`${ENDPOINT}/audio/speech`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify(body)
        });
        
        const contentType = res.headers.get('content-type');
        
        if (contentType?.includes('audio')) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const outputPath = path.join(OUTPUT_DIR, 'tts_test.mp3');
            fs.writeFileSync(outputPath, buffer);
            
            log('PASS', `TTS working! Generated ${buffer.byteLength} bytes`, 'success');
            results.tests.push({ name: 'TTS endpoint', passed: true, size: buffer.byteLength, outputPath });
            results.passed = true;
        } else {
            const data = await res.json().catch(() => ({}));
            log('WARN', `TTS not available: ${data.error?.message || 'Non-audio response'}`, 'warn');
            results.tests.push({ name: 'TTS endpoint', passed: false, note: 'Not available' });
        }
    } catch (err) {
        log('WARN', `TTS test failed: ${err.message}`, 'warn');
        results.tests.push({ name: 'TTS endpoint', passed: false, error: err.message });
    }
    
    results.tested = true;
    return results;
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}  Grok Comprehensive Test Suite         ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`API Key: ${API_KEY ? '✓ Present' : '✗ Missing'}`);
    console.log(`Endpoint: ${ENDPOINT}`);
    console.log(`Output: ${OUTPUT_DIR}`);
    
    if (!API_KEY) {
        log('FATAL', 'GROK_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    const allResults = {
        provider: 'Grok', timestamp: new Date().toISOString(),
        endpoint: ENDPOINT, capabilities: {}
    };
    
    allResults.capabilities.vision = await testVision();
    allResults.capabilities.imageGeneration = await testImageGeneration();
    allResults.capabilities.tts = await testTTS();
    
    // Summary
    logSection('FINAL SUMMARY');
    
    let passCount = 0, failCount = 0;
    
    Object.entries(allResults.capabilities).forEach(([capability, result]) => {
        if (!result.tested) {
            console.log(`⏭️  ${capability}: Skipped`);
            return;
        }
        
        if (result.passed) {
            console.log(`${colors.green}✅ ${capability}: PASSED${colors.reset}`);
            passCount++;
        } else {
            console.log(`${colors.red}❌ ${capability}: FAILED${colors.reset}`);
            failCount++;
        }
        
        if (result.tests) {
            result.tests.forEach(test => {
                const status = test.passed ? colors.green + '✓' : colors.red + '✗';
                console.log(`   ${status} ${test.name}${colors.reset}`);
            });
        }
    });
    
    console.log(`\n${colors.cyan}Total: ${passCount} passed, ${failCount} failed${colors.reset}`);
    
    const resultsPath = path.join(OUTPUT_DIR, 'comprehensive_results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
    log('SAVE', `Results saved to: ${resultsPath}`, 'info');
    
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    log('FATAL', err.message, 'error');
    process.exit(1);
});
