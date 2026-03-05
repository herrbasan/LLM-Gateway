/**
 * MiniMax Multimodal Capability Probe
 * Tests: TTS, STT, Chat
 * Note: MiniMax uses Anthropic Messages API format
 * 
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
const ENDPOINT = 'https://api.minimax.io/anthropic';

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
// TEST 1: List Models
// ==========================================
async function testListModels() {
    log('MODELS', 'Fetching available models...', 'info');
    
    try {
        const res = await fetch(`${ENDPOINT}/v1/models`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        });
        
        const data = await res.json();
        
        if (data.error) {
            log('MODELS', `Error: ${JSON.stringify(data.error)}`, 'error');
            return null;
        }
        
        const models = data.data || [];
        log('MODELS', `Found ${models.length} models`, 'success');
        
        models.forEach(m => {
            console.log(`  - ${m.id}`);
        });
        
        return models;
    } catch (err) {
        log('MODELS', `Failed: ${err.message}`, 'error');
        return null;
    }
}

// ==========================================
// TEST 2: Chat (Anthropic Format)
// ==========================================
async function testChat() {
    log('CHAT', 'Testing Chat Completion (Anthropic format)...', 'info');
    
    const model = 'MiniMax-M2.5';
    
    try {
        const body = {
            model: model,
            messages: [
                { role: 'user', content: 'Hello! What is 2+2?' }
            ],
            max_tokens: 100
        };
        
        log('CHAT', `Using model: ${model}`, 'info');
        
        const res = await fetch(`${ENDPOINT}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(body)
        });
        
        const data = await res.json();
        
        if (data.error) {
            log('CHAT', `Error: ${JSON.stringify(data.error)}`, 'error');
            return { success: false, error: data.error };
        }
        
        const text = data.content?.find(c => c.type === 'text')?.text || '';
        log('CHAT', `Response: "${text.substring(0, 100)}"`, 'success');
        
        return { success: true, model, response: text };
        
    } catch (err) {
        log('CHAT', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST 3: Text-to-Speech
// ==========================================
async function testTTS() {
    log('TTS', 'Testing Text-to-Speech...', 'info');
    
    // MiniMax has a separate TTS endpoint (not Anthropic format)
    // Docs: https://platform.minimax.io/docs/guides/tts
    const ttsEndpoint = 'https://api.minimax.io/v1/tts';
    
    const testText = 'Hello, this is a test of MiniMax text to speech.';
    
    try {
        // Try OpenAI-compatible endpoint first
        const body = {
            model: 'tts-1',
            input: testText,
            voice: 'alloy',
            response_format: 'mp3'
        };
        
        log('TTS', 'Trying OpenAI-compatible /audio/speech endpoint...', 'info');
        
        const res = await fetch(`${ttsEndpoint}/speech`, {
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
            
            if (buffer.byteLength < 1000) {
                log('TTS', 'Response too small, likely error', 'warn');
                return { success: false, error: 'Response too small' };
            }
            
            const outputPath = path.join(__dirname, 'output', 'minimax_tts.mp3');
            
            if (!fs.existsSync(path.dirname(outputPath))) {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            }
            
            fs.writeFileSync(outputPath, buffer);
            
            log('TTS', `Success! Generated ${buffer.byteLength} bytes`, 'success');
            log('TTS', `Saved to: ${outputPath}`, 'success');
            
            return { success: true, size: buffer.byteLength, path: outputPath };
        } else {
            const data = await res.json().catch(() => ({}));
            log('TTS', `TTS endpoint returned: ${data.error?.message || 'Non-audio response'}`, 'warn');
        }
        
        // Try native MiniMax TTS endpoint
        log('TTS', 'Trying native MiniMax TTS endpoint...', 'info');
        
        const nativeBody = {
            text: testText,
            voice_id: 'male-qn-qingse',  // or other voice IDs
            model: 'speech-01-turbo'
        };
        
        const nativeRes = await fetch('https://api.minimax.io/v1/t2a_v2', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(nativeBody)
        });
        
        const nativeData = await nativeRes.json();
        
        if (nativeData.audio_hex) {
            // Convert hex to buffer
            const hex = nativeData.audio_hex;
            const buffer = Buffer.from(hex, 'hex');
            
            const outputPath = path.join(__dirname, 'output', 'minimax_tts_native.mp3');
            
            if (!fs.existsSync(path.dirname(outputPath))) {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            }
            
            fs.writeFileSync(outputPath, buffer);
            
            log('TTS', `Native endpoint success!`, 'success');
            log('TTS', `  Size: ${buffer.byteLength} bytes`, 'success');
            log('TTS', `  Saved to: ${outputPath}`, 'success');
            
            return { 
                success: true, 
                method: 'native',
                size: buffer.byteLength, 
                path: outputPath 
            };
        } else if (nativeData.error) {
            log('TTS', `Native endpoint error: ${JSON.stringify(nativeData.error)}`, 'warn');
        }
        
    } catch (err) {
        log('TTS', `Failed: ${err.message}`, 'error');
    }
    
    log('TTS', 'All TTS attempts failed', 'error');
    return { success: false, error: 'TTS not available' };
}

// ==========================================
// TEST 4: Speech-to-Text
// ==========================================
async function testSTT() {
    log('STT', 'Testing Speech-to-Text...', 'info');
    
    // MiniMax may not have a dedicated STT endpoint
    // Try the standard endpoint
    try {
        const body = {
            model: 'whisper-1',
            file: 'test.mp3'  // Would need actual file upload
        };
        
        log('STT', 'STT requires file upload - checking endpoint availability...', 'info');
        
        const res = await fetch('https://api.minimax.io/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`
            }
        });
        
        if (res.status === 404) {
            log('STT', 'STT endpoint not available (404)', 'warn');
            return { success: false, error: 'STT endpoint not found', note: 'MiniMax may not expose STT via API' };
        }
        
        const data = await res.json().catch(() => null);
        log('STT', `Response: ${JSON.stringify(data)}`, 'info');
        
        return { success: false, error: 'STT not tested', note: 'Requires file upload' };
        
    } catch (err) {
        log('STT', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}   MiniMax Multimodal Capability Probe   ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    if (!API_KEY) {
        log('SETUP', 'MINIMAX_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    const results = {
        provider: 'MiniMax',
        endpoint: ENDPOINT,
        timestamp: new Date().toISOString(),
        tests: {}
    };
    
    results.tests.models = await testListModels();
    results.tests.chat = await testChat();
    results.tests.tts = await testTTS();
    results.tests.stt = await testSTT();
    
    // Summary
    console.log(`\n${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}              SUMMARY                   ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    
    Object.entries(results.tests).forEach(([test, result]) => {
        const status = result?.success ? '✅ PASS' : result?.error ? '❌ FAIL' : '⚠️  SKIP';
        const color = result?.success ? colors.green : result?.error ? colors.red : colors.yellow;
        console.log(`${color}${status}${colors.reset} ${test}`);
        if (result?.error) {
            console.log(`      Error: ${result.error.message || result.error}`);
        }
    });
    
    // Save results
    const resultsPath = path.join(__dirname, 'output', 'minimax_results.json');
    if (!fs.existsSync(path.dirname(resultsPath))) {
        fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    }
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    log('SAVE', `Results saved to: ${resultsPath}`, 'info');
}

main().catch(err => {
    log('FATAL', err.message, 'error');
    process.exit(1);
});
