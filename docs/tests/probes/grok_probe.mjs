/**
 * xAI Grok Multimodal Capability Probe
 * Tests: Image Generation, TTS, Chat
 * 
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
        const res = await fetch(`${ENDPOINT}/models`, {
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
            console.log(`  - ${m.id} (${m.object})`);
        });
        
        return models;
    } catch (err) {
        log('MODELS', `Failed: ${err.message}`, 'error');
        return null;
    }
}

// ==========================================
// TEST 2: Image Generation
// ==========================================
async function testImageGeneration() {
    log('IMAGE', 'Testing Image Generation...', 'info');
    
    // Grok's image generation model
    const model = 'grok-2-image';
    const testPrompt = 'A futuristic city skyline at sunset with flying cars';
    
    try {
        const body = {
            model: model,
            prompt: testPrompt,
            n: 1,
            response_format: 'b64_json'
        };
        
        log('IMAGE', `Using model: ${model}`, 'info');
        log('IMAGE', `Prompt: "${testPrompt}"`, 'info');
        
        const res = await fetch(`${ENDPOINT}/images/generations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(body)
        });
        
        const data = await res.json();
        
        if (data.error) {
            log('IMAGE', `API Error: ${JSON.stringify(data.error)}`, 'error');
            return { success: false, error: data.error };
        }
        
        const images = data.data || [];
        if (images.length === 0) {
            log('IMAGE', 'No images returned', 'error');
            return { success: false, error: 'No images' };
        }
        
        const b64 = images[0].b64_json;
        if (!b64) {
            log('IMAGE', `Response: ${JSON.stringify(data).substring(0, 300)}`, 'warn');
            return { success: false, error: 'No base64 data' };
        }
        
        const buffer = Buffer.from(b64, 'base64');
        const outputPath = path.join(__dirname, 'output', 'grok_image.png');
        
        if (!fs.existsSync(path.dirname(outputPath))) {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        }
        
        fs.writeFileSync(outputPath, buffer);
        
        log('IMAGE', `Success! Generated ${buffer.byteLength} bytes`, 'success');
        log('IMAGE', `Saved to: ${outputPath}`, 'success');
        
        return { success: true, size: buffer.byteLength, path: outputPath };
        
    } catch (err) {
        log('IMAGE', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST 3: Text-to-Speech
// ==========================================
async function testTTS() {
    log('TTS', 'Testing Text-to-Speech...', 'info');
    
    // Note: Grok currently doesn't expose TTS via API
    // This tests if the endpoint exists
    const testText = 'Hello from Grok text to speech.';
    
    try {
        const body = {
            model: 'grok-tts',  // Hypothetical model name
            input: testText,
            voice: 'alloy',
            response_format: 'mp3'
        };
        
        log('TTS', 'Trying /audio/speech endpoint...', 'info');
        
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
            const outputPath = path.join(__dirname, 'output', 'grok_tts.mp3');
            
            if (!fs.existsSync(path.dirname(outputPath))) {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            }
            
            fs.writeFileSync(outputPath, buffer);
            
            log('TTS', `Success! Generated ${buffer.byteLength} bytes`, 'success');
            log('TTS', `Saved to: ${outputPath}`, 'success');
            
            return { success: true, size: buffer.byteLength, path: outputPath };
        } else {
            const data = await res.json().catch(() => ({}));
            log('TTS', `TTS not available: ${data.error?.message || 'Endpoint returned non-audio'}`, 'warn');
            return { success: false, error: 'TTS not available', note: 'Grok may not expose TTS via API yet' };
        }
        
    } catch (err) {
        log('TTS', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST 4: Chat with Vision
// ==========================================
async function testVision() {
    log('VISION', 'Testing Vision capability...', 'info');
    
    const model = 'grok-2-vision-1212';
    
    // Test with a simple base64 image (red pixel)
    const testImageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    
    try {
        const body = {
            model: model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What color is this image? Answer with just the color.' },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/png;base64,${testImageB64}`
                            }
                        }
                    ]
                }
            ]
        };
        
        log('VISION', `Using model: ${model}`, 'info');
        
        const res = await fetch(`${ENDPOINT}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(body)
        });
        
        const data = await res.json();
        
        if (data.error) {
            log('VISION', `Error: ${JSON.stringify(data.error)}`, 'error');
            return { success: false, error: data.error };
        }
        
        const text = data.choices?.[0]?.message?.content || '';
        log('VISION', `Response: "${text}"`, 'success');
        
        return { success: true, response: text };
        
    } catch (err) {
        log('VISION', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}    Grok Multimodal Capability Probe     ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    if (!API_KEY) {
        log('SETUP', 'GROK_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    const results = {
        provider: 'Grok',
        endpoint: ENDPOINT,
        timestamp: new Date().toISOString(),
        tests: {}
    };
    
    results.tests.models = await testListModels();
    results.tests.imageGeneration = await testImageGeneration();
    results.tests.tts = await testTTS();
    results.tests.vision = await testVision();
    
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
    const resultsPath = path.join(__dirname, 'output', 'grok_results.json');
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
