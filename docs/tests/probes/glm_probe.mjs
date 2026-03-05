/**
 * Zhipu GLM Multimodal Capability Probe
 * Tests: Image Generation (CogView), TTS, Chat
 * 
 * Docs: https://docs.z.ai/guides/overview/quick-start
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const API_KEY = process.env.GLM_API_KEY;
const ENDPOINT = 'https://api.z.ai/api/paas/v4';

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
        
        // Categorize
        const categories = {
            chat: [],
            imageGen: [],
            tts: [],
            stt: [],
            embedding: []
        };
        
        models.forEach(m => {
            const id = m.id.toLowerCase();
            if (id.includes('cogview')) categories.imageGen.push(m.id);
            else if (id.includes('tts')) categories.tts.push(m.id);
            else if (id.includes('stt') || id.includes('whisper')) categories.stt.push(m.id);
            else if (id.includes('embed')) categories.embedding.push(m.id);
            else categories.chat.push(m.id);
        });
        
        console.log('\n--- Model Categories ---');
        Object.entries(categories).forEach(([cat, list]) => {
            if (list.length > 0) {
                console.log(`${cat.toUpperCase()}:`);
                list.forEach(m => console.log(`  - ${m}`));
            }
        });
        
        return models;
    } catch (err) {
        log('MODELS', `Failed: ${err.message}`, 'error');
        return null;
    }
}

// ==========================================
// TEST 2: Image Generation (CogView)
// ==========================================
async function testImageGeneration() {
    log('IMAGE', 'Testing Image Generation (CogView)...', 'info');
    
    // CogView models for image generation
    const modelsToTry = ['cogview-3', 'cogview-3-plus', 'cogview-4'];
    const testPrompt = 'A cute robot painting a picture, digital art style, vibrant colors';
    
    for (const model of modelsToTry) {
        try {
            log('IMAGE', `Trying model: ${model}...`, 'info');
            
            const body = {
                model: model,
                prompt: testPrompt,
                n: 1,
                size: '1024x1024'
            };
            
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
                log('IMAGE', `  ${model} error: ${data.error.message || JSON.stringify(data.error)}`, 'warn');
                continue;
            }
            
            const images = data.data || [];
            if (images.length === 0) {
                log('IMAGE', `  ${model} returned no images`, 'warn');
                continue;
            }
            
            // Check response format
            const img = images[0];
            let buffer;
            let ext = 'png';
            
            if (img.b64_json) {
                buffer = Buffer.from(img.b64_json, 'base64');
            } else if (img.url) {
                log('IMAGE', `  ${model} returned URL: ${img.url}`, 'info');
                const imgRes = await fetch(img.url);
                buffer = Buffer.from(await imgRes.arrayBuffer());
                ext = img.url.split('.').pop() || 'png';
            } else {
                log('IMAGE', `  ${model} unknown format: ${JSON.stringify(img).substring(0, 200)}`, 'warn');
                continue;
            }
            
            const outputPath = path.join(__dirname, 'output', `glm_image_${model.replace(/[^a-z0-9]/gi, '_')}.${ext}`);
            
            if (!fs.existsSync(path.dirname(outputPath))) {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            }
            
            fs.writeFileSync(outputPath, buffer);
            
            log('IMAGE', `Success with ${model}!`, 'success');
            log('IMAGE', `  Size: ${buffer.byteLength} bytes`, 'success');
            log('IMAGE', `  Saved to: ${outputPath}`, 'success');
            
            return { success: true, model, size: buffer.byteLength, path: outputPath };
            
        } catch (err) {
            log('IMAGE', `  ${model} failed: ${err.message}`, 'warn');
        }
    }
    
    log('IMAGE', 'All image generation attempts failed', 'error');
    return { success: false, error: 'No working model found' };
}

// ==========================================
// TEST 3: Text-to-Speech
// ==========================================
async function testTTS() {
    log('TTS', 'Testing Text-to-Speech...', 'info');
    
    // GLM TTS models
    const modelsToTry = [
        { model: 'glm-4-voice', voice: 'default' },
        { model: 'tts-1', voice: 'alloy' }
    ];
    
    const testText = '你好，这是智谱GLM的语音合成测试。Hello, this is Zhipu GLM text to speech test.';
    
    for (const { model, voice } of modelsToTry) {
        try {
            log('TTS', `Trying model: ${model}...`, 'info');
            
            const body = {
                model: model,
                input: testText,
                voice: voice,
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
                
                if (buffer.byteLength < 1000) {
                    log('TTS', `  ${model} returned too small buffer`, 'warn');
                    continue;
                }
                
                const outputPath = path.join(__dirname, 'output', `glm_tts_${model.replace(/[^a-z0-9]/gi, '_')}.mp3`);
                
                if (!fs.existsSync(path.dirname(outputPath))) {
                    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                }
                
                fs.writeFileSync(outputPath, buffer);
                
                log('TTS', `Success with ${model}!`, 'success');
                log('TTS', `  Size: ${buffer.byteLength} bytes`, 'success');
                log('TTS', `  Saved to: ${outputPath}`, 'success');
                
                return { success: true, model, voice, size: buffer.byteLength, path: outputPath };
            } else {
                const data = await res.json().catch(() => null);
                if (data?.error) {
                    log('TTS', `  ${model} error: ${data.error.message || JSON.stringify(data.error)}`, 'warn');
                }
            }
            
        } catch (err) {
            log('TTS', `  ${model} failed: ${err.message}`, 'warn');
        }
    }
    
    log('TTS', 'All TTS attempts failed - GLM may not expose TTS via OpenAI-compatible endpoint', 'warn');
    return { success: false, error: 'TTS not available', note: 'GLM TTS may require native API' };
}

// ==========================================
// TEST 4: Vision (GLM-4V)
// ==========================================
async function testVision() {
    log('VISION', 'Testing Vision (GLM-4V)...', 'info');
    
    // GLM vision models
    const modelsToTry = ['glm-4v-plus', 'glm-4v', 'glm-4v-flash'];
    
    const testImageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    
    for (const model of modelsToTry) {
        try {
            log('VISION', `Trying model: ${model}...`, 'info');
            
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
                log('VISION', `  ${model} error: ${data.error.message || JSON.stringify(data.error)}`, 'warn');
                continue;
            }
            
            const text = data.choices?.[0]?.message?.content || '';
            log('VISION', `Success with ${model}!`, 'success');
            log('VISION', `  Response: "${text}"`, 'success');
            
            return { success: true, model, response: text };
            
        } catch (err) {
            log('VISION', `  ${model} failed: ${err.message}`, 'warn');
        }
    }
    
    log('VISION', 'All vision attempts failed', 'error');
    return { success: false, error: 'No working model found' };
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}     GLM Multimodal Capability Probe     ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    if (!API_KEY) {
        log('SETUP', 'GLM_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    const results = {
        provider: 'GLM (Zhipu)',
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
    const resultsPath = path.join(__dirname, 'output', 'glm_results.json');
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
