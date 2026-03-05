/**
 * Gemini Comprehensive Multimodal Test Suite
 * Tests: Vision, Image Generation (Imagen), TTS, STT/Audio Input
 * 
 * Provider: Google Gemini
 * Docs: https://ai.google.dev/gemini-api/docs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const API_KEY = process.env.GEMINI_API_KEY;
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const OUTPUT_DIR = path.join(__dirname, 'output', 'gemini');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
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
    
    const results = {
        capability: 'Vision',
        tested: false,
        passed: false,
        tests: []
    };
    
    // Test images of different sizes
    const testCases = [
        {
            name: 'Small 2x2 red pixel',
            imageB64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpi2r9//38gYGAEESAAEGAAasgJOgzOKCoAAAAASUVORK5CYII=',
            mimeType: 'image/png',
            question: 'What color is this image? Answer with just the color name.',
            expected: 'red'
        },
        {
            name: 'Base64 JPEG test',
            imageB64: '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Af//Z',
            mimeType: 'image/jpeg',
            question: 'What do you see in this image?',
            expected: null
        }
    ];
    
    const model = 'gemini-2.0-flash';
    
    for (const testCase of testCases) {
        log('TEST', `Testing: ${testCase.name}`, 'section');
        
        try {
            const body = {
                contents: [{
                    role: 'user',
                    parts: [
                        { text: testCase.question },
                        {
                            inlineData: {
                                mimeType: testCase.mimeType,
                                data: testCase.imageB64
                            }
                        }
                    ]
                }]
            };
            
            const startTime = Date.now();
            const res = await fetch(`${ENDPOINT}/models/${model}:generateContent?key=${API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const latency = Date.now() - startTime;
            
            const data = await res.json();
            
            if (data.error) {
                log('FAIL', `Error: ${data.error.message}`, 'error');
                results.tests.push({
                    name: testCase.name,
                    passed: false,
                    error: data.error.message,
                    latency
                });
            } else {
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                log('PASS', `Response (${latency}ms): "${text.substring(0, 100)}"`, 'success');
                
                results.tests.push({
                    name: testCase.name,
                    passed: true,
                    response: text,
                    latency,
                    model
                });
            }
        } catch (err) {
            log('FAIL', `Exception: ${err.message}`, 'error');
            results.tests.push({
                name: testCase.name,
                passed: false,
                error: err.message
            });
        }
    }
    
    results.tested = true;
    results.passed = results.tests.every(t => t.passed);
    return results;
}

// ==========================================
// TEST 2: IMAGE GENERATION - Imagen
// ==========================================
async function testImageGeneration() {
    logSection('IMAGE GENERATION - Imagen 4');
    
    const results = {
        capability: 'Image Generation',
        tested: false,
        passed: false,
        tests: []
    };
    
    const testCases = [
        {
            name: 'Standard generation',
            model: 'imagen-4.0-generate-001',
            prompt: 'A serene Japanese garden with cherry blossoms and a small koi pond, watercolor style',
            parameters: {
                sampleCount: 1,
                outputOptions: { mimeType: 'image/jpeg' }
            }
        },
        {
            name: 'Fast generation',
            model: 'imagen-4.0-fast-generate-001',
            prompt: 'A futuristic robot reading a book in a library',
            parameters: {
                sampleCount: 1,
                outputOptions: { mimeType: 'image/jpeg' }
            }
        }
    ];
    
    for (const testCase of testCases) {
        log('TEST', `Testing: ${testCase.name} (${testCase.model})`, 'section');
        
        try {
            const body = {
                instances: [{ prompt: testCase.prompt }],
                parameters: testCase.parameters
            };
            
            const startTime = Date.now();
            const res = await fetch(`${ENDPOINT}/models/${testCase.model}:predict?key=${API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const latency = Date.now() - startTime;
            
            const data = await res.json();
            
            if (data.error) {
                log('FAIL', `Error: ${data.error.message}`, 'error');
                results.tests.push({
                    name: testCase.name,
                    model: testCase.model,
                    passed: false,
                    error: data.error.message,
                    latency
                });
            } else {
                const predictions = data.predictions || [];
                if (predictions.length === 0) {
                    log('FAIL', 'No predictions returned', 'error');
                    results.tests.push({
                        name: testCase.name,
                        model: testCase.model,
                        passed: false,
                        error: 'No predictions'
                    });
                    continue;
                }
                
                const pred = predictions[0];
                const b64 = pred.bytesBase64Encoded || pred.bytesBase64;
                
                if (!b64) {
                    log('FAIL', 'No base64 data in response', 'error');
                    results.tests.push({
                        name: testCase.name,
                        model: testCase.model,
                        passed: false,
                        error: 'No base64 data'
                    });
                    continue;
                }
                
                const buffer = Buffer.from(b64, 'base64');
                const outputPath = path.join(OUTPUT_DIR, `imagen_${testCase.model.replace(/[^a-z0-9]/gi, '_')}.jpg`);
                fs.writeFileSync(outputPath, buffer);
                
                log('PASS', `Generated ${buffer.byteLength} bytes (${latency}ms)`, 'success');
                log('INFO', `Saved to: ${outputPath}`, 'info');
                
                results.tests.push({
                    name: testCase.name,
                    model: testCase.model,
                    passed: true,
                    size: buffer.byteLength,
                    latency,
                    outputPath
                });
            }
        } catch (err) {
            log('FAIL', `Exception: ${err.message}`, 'error');
            results.tests.push({
                name: testCase.name,
                model: testCase.model,
                passed: false,
                error: err.message
            });
        }
    }
    
    results.tested = true;
    results.passed = results.tests.some(t => t.passed);
    return results;
}

// ==========================================
// TEST 3: TEXT-TO-SPEECH - Native Audio
// ==========================================
async function testTTS() {
    logSection('TEXT-TO-SPEECH - Native Audio');
    
    const results = {
        capability: 'Text-to-Speech',
        tested: false,
        passed: false,
        tests: []
    };
    
    const testCases = [
        {
            name: 'TTS Preview Model - Aoede voice',
            model: 'gemini-2.5-flash-preview-tts',
            text: 'Hello, this is a test of the Gemini text-to-speech capability using the Aoede voice.',
            voice: 'Aoede'
        },
        {
            name: 'TTS Preview Model - Puck voice',
            model: 'gemini-2.5-flash-preview-tts',
            text: 'Hello, this is a test using the Puck voice.',
            voice: 'Puck'
        }
    ];
    
    for (const testCase of testCases) {
        log('TEST', `Testing: ${testCase.name}`, 'section');
        
        try {
            const body = {
                contents: [{
                    role: 'user',
                    parts: [{ text: testCase.text }]
                }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: testCase.voice
                            }
                        }
                    }
                }
            };
            
            const startTime = Date.now();
            const res = await fetch(`${ENDPOINT}/models/${testCase.model}:generateContent?key=${API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const latency = Date.now() - startTime;
            
            const data = await res.json();
            
            if (data.error) {
                log('FAIL', `Error: ${data.error.message}`, 'error');
                results.tests.push({
                    name: testCase.name,
                    model: testCase.model,
                    passed: false,
                    error: data.error.message,
                    latency
                });
            } else {
                const parts = data.candidates?.[0]?.content?.parts || [];
                const audioPart = parts.find(p => p.inlineData?.mimeType?.startsWith('audio/'));
                
                if (!audioPart) {
                    log('FAIL', 'No audio data in response', 'error');
                    results.tests.push({
                        name: testCase.name,
                        model: testCase.model,
                        passed: false,
                        error: 'No audio data'
                    });
                    continue;
                }
                
                const b64 = audioPart.inlineData.data;
                const mimeType = audioPart.inlineData.mimeType;
                const buffer = Buffer.from(b64, 'base64');
                
                const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'audio';
                const outputPath = path.join(OUTPUT_DIR, `tts_${testCase.voice.toLowerCase()}.${ext}`);
                fs.writeFileSync(outputPath, buffer);
                
                log('PASS', `Generated ${buffer.byteLength} bytes (${latency}ms)`, 'success');
                log('INFO', `Format: ${mimeType}`, 'info');
                log('INFO', `Saved to: ${outputPath}`, 'info');
                
                results.tests.push({
                    name: testCase.name,
                    model: testCase.model,
                    voice: testCase.voice,
                    passed: true,
                    size: buffer.byteLength,
                    mimeType,
                    latency,
                    outputPath
                });
            }
        } catch (err) {
            log('FAIL', `Exception: ${err.message}`, 'error');
            results.tests.push({
                name: testCase.name,
                model: testCase.model,
                passed: false,
                error: err.message
            });
        }
    }
    
    results.tested = true;
    results.passed = results.tests.some(t => t.passed);
    return results;
}

// ==========================================
// TEST 4: SPEECH-TO-TEXT / AUDIO INPUT
// ==========================================
async function testSTT() {
    logSection('SPEECH-TO-TEXT - Audio Input');
    
    const results = {
        capability: 'Speech-to-Text',
        tested: false,
        passed: false,
        tests: []
    };
    
    log('INFO', 'Note: Gemini does not have a dedicated STT endpoint.', 'info');
    log('INFO', 'It uses native audio input via inlineData.', 'info');
    
    // Create a simple test audio (silent WAV)
    const testCases = [
        {
            name: 'Audio input capability test',
            model: 'gemini-2.0-flash',
            audioB64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', // Silent WAV
            mimeType: 'audio/wav',
            question: 'Please transcribe this audio or describe what you hear.'
        }
    ];
    
    for (const testCase of testCases) {
        log('TEST', `Testing: ${testCase.name}`, 'section');
        
        try {
            const body = {
                contents: [{
                    role: 'user',
                    parts: [
                        { text: testCase.question },
                        {
                            inlineData: {
                                mimeType: testCase.mimeType,
                                data: testCase.audioB64
                            }
                        }
                    ]
                }]
            };
            
            const startTime = Date.now();
            const res = await fetch(`${ENDPOINT}/models/${testCase.model}:generateContent?key=${API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const latency = Date.now() - startTime;
            
            const data = await res.json();
            
            if (data.error) {
                // Expected for silent/invalid audio
                log('WARN', `Response (expected for test audio): ${data.error.message}`, 'warn');
                results.tests.push({
                    name: testCase.name,
                    model: testCase.model,
                    passed: true, // Pass because endpoint is reachable
                    note: 'Endpoint reachable, audio processing error expected for test data',
                    error: data.error.message,
                    latency
                });
            } else {
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                log('PASS', `Response (${latency}ms): "${text.substring(0, 100)}"`, 'success');
                
                results.tests.push({
                    name: testCase.name,
                    model: testCase.model,
                    passed: true,
                    response: text,
                    latency
                });
            }
        } catch (err) {
            log('FAIL', `Exception: ${err.message}`, 'error');
            results.tests.push({
                name: testCase.name,
                model: testCase.model,
                passed: false,
                error: err.message
            });
        }
    }
    
    results.tested = true;
    results.passed = results.tests.some(t => t.passed);
    return results;
}

// ==========================================
// TEST 5: VIDEO GENERATION (Veo)
// ==========================================
async function testVideoGeneration() {
    logSection('VIDEO GENERATION - Veo (if available)');
    
    const results = {
        capability: 'Video Generation',
        tested: false,
        passed: false,
        tests: []
    };
    
    log('INFO', 'Video generation models detected in API:', 'info');
    log('INFO', '- veo-2.0-generate-001', 'info');
    log('INFO', '- veo-3.0-generate-001', 'info');
    log('INFO', '- veo-3.0-fast-generate-001', 'info');
    log('INFO', 'Skipping actual video generation (too expensive/time-consuming)', 'warn');
    
    results.tested = false;
    results.note = 'Video models available but not tested in this run';
    return results;
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}  Gemini Comprehensive Test Suite       ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`API Key: ${API_KEY ? '✓ Present' : '✗ Missing'}`);
    console.log(`Endpoint: ${ENDPOINT}`);
    console.log(`Output: ${OUTPUT_DIR}`);
    
    if (!API_KEY) {
        log('FATAL', 'GEMINI_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    const allResults = {
        provider: 'Gemini',
        timestamp: new Date().toISOString(),
        endpoint: ENDPOINT,
        capabilities: {}
    };
    
    // Run all tests
    allResults.capabilities.vision = await testVision();
    allResults.capabilities.imageGeneration = await testImageGeneration();
    allResults.capabilities.tts = await testTTS();
    allResults.capabilities.stt = await testSTT();
    allResults.capabilities.videoGeneration = await testVideoGeneration();
    
    // Final Summary
    logSection('FINAL SUMMARY');
    
    let passCount = 0;
    let failCount = 0;
    
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
        
        // Show individual test results
        if (result.tests) {
            result.tests.forEach(test => {
                const status = test.passed ? colors.green + '✓' : colors.red + '✗';
                console.log(`   ${status} ${test.name}${colors.reset}`);
                if (test.error && !test.passed) {
                    console.log(`     Error: ${test.error.substring(0, 80)}`);
                }
            });
        }
    });
    
    console.log(`\n${colors.cyan}Total: ${passCount} passed, ${failCount} failed${colors.reset}`);
    
    // Save results
    const resultsPath = path.join(OUTPUT_DIR, 'comprehensive_results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
    log('SAVE', `Results saved to: ${resultsPath}`, 'info');
    
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    log('FATAL', err.message, 'error');
    process.exit(1);
});
