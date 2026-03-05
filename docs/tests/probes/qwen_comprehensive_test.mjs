/**
 * Qwen Comprehensive Multimodal Test Suite
 * Tests: Vision, Image Generation (Wanx), TTS
 * 
 * Provider: Alibaba DashScope
 * Docs: https://www.alibabacloud.com/help/en/model-studio/getting-started/what-is-model-studio
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const API_KEY = process.env.QWEN_API_KEY;
const ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const NATIVE_ENDPOINT = 'https://dashscope-intl.aliyuncs.com/api/v1';
const OUTPUT_DIR = path.join(__dirname, 'output', 'qwen');

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
// TEST 1: VISION
// ==========================================
async function testVision() {
    logSection('VISION - Image Input Analysis');
    
    const results = { capability: 'Vision', tested: false, passed: false, tests: [] };
    
    const testCases = [
        { name: 'Qwen-VL Plus', model: 'qwen-vl-plus' },
        { name: 'Qwen-VL Max', model: 'qwen-vl-max' }
    ];
    
    // Larger test image (Qwen requires >10px dimensions)
    const testImageB64 = 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABhJREFUeNpi/P//PwM1ARMDncCoaWA0EAAQYACtCAw3qTDkAAAAAElFTkSuQmCC';
    
    for (const testCase of testCases) {
        log('TEST', `Testing: ${testCase.name} (${testCase.model})`, 'section');
        
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
                log('FAIL', `Error: ${data.error.message || JSON.stringify(data.error)}`, 'error');
                results.tests.push({
                    name: testCase.name, model: testCase.model,
                    passed: false, error: data.error, latency
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
// TEST 2: IMAGE GENERATION (Wanx)
// ==========================================
async function testImageGeneration() {
    logSection('IMAGE GENERATION - Wanx');
    
    const results = { capability: 'Image Generation', tested: false, passed: false, tests: [] };
    
    // Test both OpenAI-compat and native endpoints
    const testCases = [
        {
            name: 'OpenAI-compatible endpoint',
            endpoint: `${ENDPOINT}/images/generations`,
            model: 'wanx-v1',
            body: {
                model: 'wanx-v1',
                prompt: 'A beautiful Chinese landscape painting with mountains and mist',
                n: 1,
                size: '1024x1024'
            }
        },
        {
            name: 'Native API endpoint',
            endpoint: `${NATIVE_ENDPOINT}/services/aigc/text2image/image-synthesis`,
            model: 'wanx-v1',
            body: {
                model: 'wanx-v1',
                input: { prompt: 'A futuristic city in traditional Chinese art style' }
            }
        }
    ];
    
    for (const testCase of testCases) {
        log('TEST', `Testing: ${testCase.name}`, 'section');
        
        try {
            const startTime = Date.now();
            const res = await fetch(testCase.endpoint, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${API_KEY}` 
                },
                body: JSON.stringify(testCase.body)
            });
            const latency = Date.now() - startTime;
            
            const data = await res.json();
            
            if (data.error) {
                log('FAIL', `Error: ${JSON.stringify(data.error)}`, 'error');
                results.tests.push({
                    name: testCase.name, endpoint: testCase.endpoint,
                    passed: false, error: data.error, latency
                });
            } else if (data.data) {
                // OpenAI format
                const images = data.data;
                if (images.length > 0) {
                    log('INFO', `Response received (${latency}ms)`, 'info');
                    log('INFO', `Format: ${images[0].url ? 'URL' : images[0].b64_json ? 'Base64' : 'Unknown'}`, 'info');
                    results.tests.push({
                        name: testCase.name, endpoint: testCase.endpoint,
                        passed: true, format: 'openai', latency
                    });
                }
            } else if (data.output) {
                // Native format
                log('INFO', `Native API response (${latency}ms)`, 'info');
                results.tests.push({
                    name: testCase.name, endpoint: testCase.endpoint,
                    passed: true, format: 'native', latency
                });
            } else {
                log('INFO', `Response: ${JSON.stringify(data).substring(0, 200)}`, 'info');
                results.tests.push({
                    name: testCase.name, endpoint: testCase.endpoint,
                    passed: true, format: 'unknown', latency
                });
            }
        } catch (err) {
            log('FAIL', `Exception: ${err.message}`, 'error');
            results.tests.push({
                name: testCase.name, endpoint: testCase.endpoint,
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
    
    // Test different TTS models
    const testCases = [
        { name: 'Sambert TTS (zhichu)', model: 'sambert-zhichu-v1', voice: 'zhichu' },
        { name: 'OpenAI-compatible TTS', model: 'tts-1', voice: 'alloy' }
    ];
    
    for (const testCase of testCases) {
        log('TEST', `Testing: ${testCase.name}`, 'section');
        
        try {
            const body = {
                model: testCase.model,
                input: '你好，这是阿里云通义千问的语音合成测试。',
                voice: testCase.voice,
                response_format: 'mp3'
            };
            
            const startTime = Date.now();
            const res = await fetch(`${ENDPOINT}/audio/speech`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${API_KEY}`,
                    'Accept': 'audio/mpeg'
                },
                body: JSON.stringify(body)
            });
            const latency = Date.now() - startTime;
            
            const contentType = res.headers.get('content-type');
            
            if (contentType?.includes('audio')) {
                const buffer = Buffer.from(await res.arrayBuffer());
                const outputPath = path.join(OUTPUT_DIR, `tts_${testCase.voice}.mp3`);
                fs.writeFileSync(outputPath, buffer);
                
                log('PASS', `Generated ${buffer.byteLength} bytes (${latency}ms)`, 'success');
                results.tests.push({
                    name: testCase.name, model: testCase.model,
                    passed: true, size: buffer.byteLength, latency, outputPath
                });
            } else {
                const data = await res.json().catch(() => ({}));
                log('WARN', `Not audio: ${data.error?.message || 'Unknown'}`, 'warn');
                results.tests.push({
                    name: testCase.name, model: testCase.model,
                    passed: false, note: 'Non-audio response'
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
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}  Qwen Comprehensive Test Suite         ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`API Key: ${API_KEY ? '✓ Present' : '✗ Missing'}`);
    console.log(`OpenAI Endpoint: ${ENDPOINT}`);
    console.log(`Native Endpoint: ${NATIVE_ENDPOINT}`);
    
    if (!API_KEY) {
        log('FATAL', 'QWEN_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    const allResults = {
        provider: 'Qwen', timestamp: new Date().toISOString(),
        endpoints: { openai: ENDPOINT, native: NATIVE_ENDPOINT },
        capabilities: {}
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
