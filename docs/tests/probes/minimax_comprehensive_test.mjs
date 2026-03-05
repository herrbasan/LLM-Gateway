/**
 * MiniMax Comprehensive Multimodal Test Suite
 * Tests: TTS (MiniMax has limited multimodal support)
 * 
 * Provider: MiniMax
 * Docs: https://platform.minimax.io/docs/guides/models-intro
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const API_KEY = process.env.MINIMAX_API_KEY;
const ANTHROPIC_ENDPOINT = 'https://api.minimax.io/anthropic';
const OPENAI_ENDPOINT = 'https://api.minimax.io/v1';
const NATIVE_ENDPOINT = 'https://api.minimax.io';
const OUTPUT_DIR = path.join(__dirname, 'output', 'minimax');

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
// TEST 1: CHAT (Baseline)
// ==========================================
async function testChat() {
    logSection('CHAT - Baseline Test');
    
    const results = { capability: 'Chat', tested: false, passed: false, tests: [] };
    
    try {
        const body = {
            model: 'MiniMax-M2.5',
            messages: [{ role: 'user', content: 'What is 2+2?' }],
            max_tokens: 50
        };
        
        const startTime = Date.now();
        const res = await fetch(`${ANTHROPIC_ENDPOINT}/v1/messages`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${API_KEY}` 
            },
            body: JSON.stringify(body)
        });
        const latency = Date.now() - startTime;
        
        const data = await res.json();
        
        if (data.error) {
            log('FAIL', `Error: ${JSON.stringify(data.error)}`, 'error');
            results.tests.push({ name: 'Chat', passed: false, error: data.error });
        } else {
            const text = data.content?.find(c => c.type === 'text')?.text || '';
            log('PASS', `Response (${latency}ms): "${text.substring(0, 100)}"`, 'success');
            results.tests.push({ name: 'Chat', passed: true, response: text, latency });
            results.passed = true;
        }
    } catch (err) {
        log('FAIL', `Exception: ${err.message}`, 'error');
        results.tests.push({ name: 'Chat', passed: false, error: err.message });
    }
    
    results.tested = true;
    return results;
}

// ==========================================
// TEST 2: TEXT-TO-SPEECH (Multiple endpoints)
// ==========================================
async function testTTS() {
    logSection('TEXT-TO-SPEECH - Multiple Endpoints');
    
    const results = { capability: 'Text-to-Speech', tested: false, passed: false, tests: [] };
    
    // Test 1: OpenAI-compatible endpoint
    log('TEST', 'Testing OpenAI-compatible endpoint...', 'section');
    try {
        const body = {
            model: 'tts-1',
            input: 'Hello, this is a MiniMax text to speech test.',
            voice: 'alloy',
            response_format: 'mp3'
        };
        
        const res = await fetch(`${OPENAI_ENDPOINT}/audio/speech`, {
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
            const outputPath = path.join(OUTPUT_DIR, 'tts_openai.mp3');
            fs.writeFileSync(outputPath, buffer);
            
            log('PASS', `OpenAI endpoint working! ${buffer.byteLength} bytes`, 'success');
            results.tests.push({
                name: 'OpenAI-compatible TTS', endpoint: `${OPENAI_ENDPOINT}/audio/speech`,
                passed: true, size: buffer.byteLength, outputPath
            });
        } else {
            const data = await res.json().catch(() => ({}));
            log('WARN', `OpenAI endpoint: ${data.error?.message || 'Non-audio response'}`, 'warn');
            results.tests.push({
                name: 'OpenAI-compatible TTS', endpoint: `${OPENAI_ENDPOINT}/audio/speech`,
                passed: false, note: 'Not available'
            });
        }
    } catch (err) {
        log('WARN', `OpenAI endpoint exception: ${err.message}`, 'warn');
        results.tests.push({
            name: 'OpenAI-compatible TTS', endpoint: `${OPENAI_ENDPOINT}/audio/speech`,
            passed: false, error: err.message
        });
    }
    
    // Test 2: Native TTS endpoint
    log('TEST', 'Testing native TTS endpoint...', 'section');
    try {
        const body = {
            text: 'Hello, this is a MiniMax text to speech test via native API.',
            voice_id: 'male-qn-qingse',
            model: 'speech-01-turbo'
        };
        
        const res = await fetch(`${NATIVE_ENDPOINT}/v1/t2a_v2`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${API_KEY}` 
            },
            body: JSON.stringify(body)
        });
        
        const data = await res.json();
        
        if (data.audio_hex) {
            const buffer = Buffer.from(data.audio_hex, 'hex');
            const outputPath = path.join(OUTPUT_DIR, 'tts_native.mp3');
            fs.writeFileSync(outputPath, buffer);
            
            log('PASS', `Native endpoint working! ${buffer.byteLength} bytes`, 'success');
            results.tests.push({
                name: 'Native TTS (t2a_v2)', endpoint: `${NATIVE_ENDPOINT}/v1/t2a_v2`,
                passed: true, size: buffer.byteLength, outputPath
            });
        } else if (data.error) {
            log('WARN', `Native endpoint error: ${JSON.stringify(data.error)}`, 'warn');
            results.tests.push({
                name: 'Native TTS (t2a_v2)', endpoint: `${NATIVE_ENDPOINT}/v1/t2a_v2`,
                passed: false, error: data.error
            });
        } else {
            log('INFO', `Native endpoint response: ${JSON.stringify(data).substring(0, 200)}`, 'info');
            results.tests.push({
                name: 'Native TTS (t2a_v2)', endpoint: `${NATIVE_ENDPOINT}/v1/t2a_v2`,
                passed: false, note: 'No audio_hex in response'
            });
        }
    } catch (err) {
        log('WARN', `Native endpoint exception: ${err.message}`, 'warn');
        results.tests.push({
            name: 'Native TTS (t2a_v2)', endpoint: `${NATIVE_ENDPOINT}/v1/t2a_v2`,
            passed: false, error: err.message
        });
    }
    
    results.tested = true;
    results.passed = results.tests.some(t => t.passed);
    return results;
}

// ==========================================
// TEST 3: SPEECH-TO-TEXT
// ==========================================
async function testSTT() {
    logSection('SPEECH-TO-TEXT');
    
    const results = { capability: 'Speech-to-Text', tested: false, passed: false, tests: [] };
    
    log('INFO', 'Checking STT endpoint availability...', 'info');
    
    try {
        const res = await fetch(`${OPENAI_ENDPOINT}/audio/transcriptions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        });
        
        if (res.status === 404) {
            log('WARN', 'STT endpoint not found (404)', 'warn');
            results.tests.push({
                name: 'STT endpoint check',
                passed: false,
                note: 'Endpoint returns 404 - STT not available'
            });
        } else {
            const data = await res.json().catch(() => null);
            log('INFO', `STT response: ${JSON.stringify(data)}`, 'info');
            results.tests.push({
                name: 'STT endpoint check',
                passed: false,
                note: 'Unexpected response'
            });
        }
    } catch (err) {
        log('WARN', `STT check failed: ${err.message}`, 'warn');
        results.tests.push({
            name: 'STT endpoint check',
            passed: false,
            error: err.message
        });
    }
    
    results.tested = true;
    return results;
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}  MiniMax Comprehensive Test Suite      ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`API Key: ${API_KEY ? '✓ Present' : '✗ Missing'}`);
    console.log(`Anthropic Endpoint: ${ANTHROPIC_ENDPOINT}`);
    console.log(`OpenAI Endpoint: ${OPENAI_ENDPOINT}`);
    console.log(`Native Endpoint: ${NATIVE_ENDPOINT}`);
    
    if (!API_KEY) {
        log('FATAL', 'MINIMAX_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    const allResults = {
        provider: 'MiniMax', timestamp: new Date().toISOString(),
        endpoints: { anthropic: ANTHROPIC_ENDPOINT, openai: OPENAI_ENDPOINT, native: NATIVE_ENDPOINT },
        capabilities: {}
    };
    
    allResults.capabilities.chat = await testChat();
    allResults.capabilities.tts = await testTTS();
    allResults.capabilities.stt = await testSTT();
    
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
