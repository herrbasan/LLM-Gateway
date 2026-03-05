/**
 * Grok API Investigation - Testing exact model names and endpoints
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
// TEST: Image Generation with exact API models
// ==========================================
async function testImageGeneration() {
    log('IMAGE', 'Testing Image Generation with exact model names...', 'info');
    
    // Use exact model names from API listing
    const modelsToTry = [
        'grok-imagine-image',
        'grok-imagine-image-pro',
        'grok-2-image-1212'  // Try the exact format from list
    ];
    
    const testPrompt = 'A futuristic city skyline at sunset with flying cars';
    
    for (const model of modelsToTry) {
        try {
            log('IMAGE', `Trying model: ${model}...`, 'info');
            
            const body = {
                model: model,
                prompt: testPrompt,
                n: 1
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
                log('IMAGE', `  ${model} error: ${JSON.stringify(data.error)}`, 'warn');
                continue;
            }
            
            log('IMAGE', `  Response: ${JSON.stringify(data).substring(0, 300)}...`, 'info');
            
            const images = data.data || [];
            if (images.length === 0) {
                log('IMAGE', `  ${model} returned no images`, 'warn');
                continue;
            }
            
            const b64 = images[0].b64_json || images[0].url;
            if (!b64) {
                log('IMAGE', `  ${model} no image data found`, 'warn');
                continue;
            }
            
            let buffer;
            if (images[0].b64_json) {
                buffer = Buffer.from(b64, 'base64');
            } else {
                // Fetch from URL
                const imgRes = await fetch(b64);
                buffer = Buffer.from(await imgRes.arrayBuffer());
            }
            
            const outputPath = path.join(__dirname, 'output', `grok_image_${model.replace(/[^a-z0-9]/gi, '_')}.png`);
            
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
    
    return { success: false, error: 'No working model found' };
}

// ==========================================
// TEST: Vision with exact model names
// ==========================================
async function testVision() {
    log('VISION', 'Testing Vision with available models...', 'info');
    
    // Try available models for vision capability
    const modelsToTry = [
        'grok-3',
        'grok-3-mini',
        'grok-2-vision-1212'  // This might be the issue - need to check exact name
    ];
    
    // 2x2 red pixel image (larger than 1x1 to avoid size issues)
    const testImageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpi2r9//38gYGAEESAAEGAAasgJOgzOKCoAAAAASUVORK5CYII=';
    
    for (const model of modelsToTry) {
        try {
            log('VISION', `Trying model: ${model}...`, 'info');
            
            const body = {
                model: model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'What color is this image? Answer with just the color name.' },
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
                log('VISION', `  ${model} error: ${JSON.stringify(data.error)}`, 'warn');
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
    
    return { success: false, error: 'No working model found' };
}

// ==========================================
// TEST: Check which models are actually available
// ==========================================
async function checkModelAccess() {
    log('ACCESS', 'Checking model access permissions...', 'info');
    
    const modelsToCheck = [
        'grok-3',
        'grok-3-mini',
        'grok-4-0709',
        'grok-4-fast-non-reasoning',
        'grok-imagine-image',
        'grok-imagine-image-pro',
        'grok-imagine-video'
    ];
    
    for (const model of modelsToCheck) {
        try {
            // Try a simple chat completion to check access
            const body = {
                model: model,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 10
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
                log('ACCESS', `  ${model}: ❌ ${data.error.message?.substring(0, 60)}...`, 'error');
            } else {
                log('ACCESS', `  ${model}: ✅ Accessible`, 'success');
            }
        } catch (err) {
            log('ACCESS', `  ${model}: ❌ ${err.message}`, 'error');
        }
    }
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}    Grok API Investigation Probe         ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    if (!API_KEY) {
        log('SETUP', 'GROK_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    await checkModelAccess();
    console.log('');
    
    const imageResult = await testImageGeneration();
    console.log('');
    
    const visionResult = await testVision();
    console.log('');
    
    // Summary
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}              SUMMARY                   ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`Image Generation: ${imageResult.success ? colors.green + '✅ PASS' : colors.red + '❌ FAIL'}${colors.reset}`);
    console.log(`Vision: ${visionResult.success ? colors.green + '✅ PASS' : colors.red + '❌ FAIL'}${colors.reset}`);
}

main().catch(err => {
    log('FATAL', err.message, 'error');
    process.exit(1);
});
