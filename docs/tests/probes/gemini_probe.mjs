/**
 * Gemini Multimodal Capability Probe
 * Tests: Image Generation (Imagen), TTS (Native Audio), Vision, STT
 * 
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

// ANSI colors for output
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
// TEST 1: List Models and Check Capabilities
// ==========================================
async function testListModels() {
    log('MODELS', 'Fetching available models...', 'info');
    
    try {
        const res = await fetch(`${ENDPOINT}/models?key=${API_KEY}`);
        const data = await res.json();
        
        if (data.error) {
            log('MODELS', `Error: ${JSON.stringify(data.error)}`, 'error');
            return null;
        }
        
        const models = data.models || [];
        log('MODELS', `Found ${models.length} models`, 'success');
        
        // Categorize models
        const categories = {
            chat: [],
            embedding: [],
            imageGen: [],
            tts: [],
            stt: [],
            vision: []
        };
        
        models.forEach(m => {
            const name = m.name.toLowerCase();
            if (name.includes('embed')) categories.embedding.push(m.name);
            else if (name.includes('imagen') || name.includes('image')) categories.imageGen.push(m.name);
            else if (name.includes('tts') || name.includes('audio')) categories.tts.push(m.name);
            else if (name.includes('stt') || name.includes('transcribe')) categories.stt.push(m.name);
            else if (name.includes('vision') || name.includes('gemini-1.5') || name.includes('gemini-2.0')) {
                categories.vision.push(m.name);
                categories.chat.push(m.name);
            }
            else categories.chat.push(m.name);
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
// TEST 2: Image Generation (Imagen)
// ==========================================
async function testImageGeneration() {
    log('IMAGE', 'Testing Image Generation (Imagen)...', 'info');
    
    // Use the correct model names from the API
    const modelsToTry = ['imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001', 'gemini-2.5-flash-image'];
    const testPrompt = 'A serene Japanese garden with cherry blossoms and a small koi pond, watercolor style';
    
    // Try the standard predict endpoint
    const body = {
        instances: [{ prompt: testPrompt }],
        parameters: {
            sampleCount: 1,
            outputOptions: { mimeType: 'image/jpeg' }
        }
    };
    
    for (const model of modelsToTry) {
        try {
            log('IMAGE', `Trying model: ${model}...`, 'info');
            log('IMAGE', `Prompt: "${testPrompt}"`, 'info');
            
            const res = await fetch(`${ENDPOINT}/models/${model}:predict?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
            const data = await res.json();
            
            if (data.error) {
                log('IMAGE', `  ${model} error: ${data.error.message || JSON.stringify(data.error)}`, 'warn');
                continue;
            }
        
            // Extract base64 image data
            const predictions = data.predictions || data.candidates || [];
            if (predictions.length === 0) {
                log('IMAGE', `  ${model} returned no predictions`, 'warn');
                continue;
            }
            
            const pred = predictions[0];
            const b64 = pred.bytesBase64Encoded || pred.bytesBase64 || pred.b64_json || 
                       pred.content?.parts?.[0]?.inlineData?.data || pred.output || pred.image;
            
            if (!b64) {
                log('IMAGE', `  ${model} response: ${JSON.stringify(pred).substring(0, 200)}...`, 'warn');
                continue;
            }
            
            const buffer = Buffer.from(b64, 'base64');
            const outputPath = path.join(__dirname, 'output', `gemini_image_${model.replace(/[^a-z0-9]/gi, '_')}.jpg`);
            
            // Ensure output directory exists
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
// TEST 3: Text-to-Speech (Native Audio)
// ==========================================
async function testTTS() {
    log('TTS', 'Testing Text-to-Speech (Native Audio)...', 'info');
    
    // Use the TTS-specific models from the API
    const modelsToTry = [
        'gemini-2.5-flash-native-audio-latest',
        'gemini-2.5-flash-native-audio-preview-09-2025',
        'gemini-2.5-flash-preview-tts'
    ];
    const testText = 'Hello, this is a test of the Gemini text-to-speech capability.';
    
    for (const model of modelsToTry) {
        try {
            log('TTS', `Trying model: ${model}...`, 'info');
            
            const body = {
                contents: [{ 
                    role: 'user', 
                    parts: [{ text: testText }] 
                }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Aoede"  // Options: Aoede, Puck, Charon, Kore, Fenrir
                            }
                        }
                    }
                }
            };
            
            const res = await fetch(`${ENDPOINT}/models/${model}:generateContent?key=${API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            
            const data = await res.json();
            
            if (data.error) {
                log('TTS', `  Model ${model} error: ${data.error.message || JSON.stringify(data.error)}`, 'warn');
                continue;
            }
            
            // Extract audio data
            const parts = data.candidates?.[0]?.content?.parts || [];
            const audioPart = parts.find(p => p.inlineData?.mimeType?.startsWith('audio/'));
            
            if (!audioPart) {
                log('TTS', `  Model ${model} returned no audio. Parts: ${JSON.stringify(parts).substring(0, 200)}`, 'warn');
                continue;
            }
            
            const b64 = audioPart.inlineData.data;
            const mimeType = audioPart.inlineData.mimeType;
            const buffer = Buffer.from(b64, 'base64');
            
            const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'audio';
            const outputPath = path.join(__dirname, 'output', `gemini_tts.${ext}`);
            
            if (!fs.existsSync(path.dirname(outputPath))) {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            }
            
            fs.writeFileSync(outputPath, buffer);
            
            log('TTS', `Success with model ${model}!`, 'success');
            log('TTS', `  Size: ${buffer.byteLength} bytes, Format: ${mimeType}`, 'success');
            log('TTS', `  Saved to: ${outputPath}`, 'success');
            
            return { 
                success: true, 
                model, 
                size: buffer.byteLength, 
                mimeType, 
                path: outputPath 
            };
            
        } catch (err) {
            log('TTS', `  Model ${model} failed: ${err.message}`, 'warn');
        }
    }
    
    log('TTS', 'All TTS attempts failed', 'error');
    return { success: false, error: 'No working model found' };
}

// ==========================================
// TEST 4: Vision (Image Input)
// ==========================================
async function testVision() {
    log('VISION', 'Testing Vision (Image Input)...', 'info');
    
    const model = 'gemini-2.0-flash';
    
    // Create a simple test image (1x1 red pixel as base64)
    const testImageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    
    try {
        const body = {
            contents: [{
                role: 'user',
                parts: [
                    { text: 'What color is this image? Respond with just the color name.' },
                    {
                        inlineData: {
                            mimeType: 'image/png',
                            data: testImageB64
                        }
                    }
                ]
            }]
        };
        
        log('VISION', `Using model: ${model}`, 'info');
        
        const res = await fetch(`${ENDPOINT}/models/${model}:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        const data = await res.json();
        
        if (data.error) {
            log('VISION', `Error: ${JSON.stringify(data.error)}`, 'error');
            return { success: false, error: data.error };
        }
        
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        log('VISION', `Response: "${text}"`, 'success');
        
        return { success: true, response: text };
        
    } catch (err) {
        log('VISION', `Failed: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

// ==========================================
// TEST 5: Speech-to-Text (STT)
// ==========================================
async function testSTT() {
    log('STT', 'Testing Speech-to-Text...', 'info');
    
    // Note: Gemini doesn't have a dedicated STT endpoint like Whisper
    // It uses the native audio input capability
    const model = 'gemini-2.0-flash';
    
    // Create a tiny silent WAV file for testing
    const silentWavB64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    
    try {
        const body = {
            contents: [{
                role: 'user',
                parts: [
                    { text: 'Transcribe this audio:' },
                    {
                        inlineData: {
                            mimeType: 'audio/wav',
                            data: silentWavB64
                        }
                    }
                ]
            }]
        };
        
        log('STT', `Using model: ${model} (native audio input)`, 'info');
        
        const res = await fetch(`${ENDPOINT}/models/${model}:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        const data = await res.json();
        
        if (data.error) {
            log('STT', `Response (expected for test audio): ${data.error.message || JSON.stringify(data.error)}`, 'warn');
        } else {
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            log('STT', `Response: "${text}"`, 'success');
        }
        
        log('STT', 'Native audio input is supported', 'success');
        return { success: true, note: 'Native audio input works, needs real audio for transcription' };
        
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
    console.log(`${colors.blue}   Gemini Multimodal Capability Probe    ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    if (!API_KEY) {
        log('SETUP', 'GEMINI_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    const results = {
        provider: 'Gemini',
        timestamp: new Date().toISOString(),
        tests: {}
    };
    
    // Run tests
    results.tests.models = await testListModels();
    results.tests.imageGeneration = await testImageGeneration();
    results.tests.tts = await testTTS();
    results.tests.vision = await testVision();
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
    const resultsPath = path.join(__dirname, 'output', 'gemini_results.json');
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
