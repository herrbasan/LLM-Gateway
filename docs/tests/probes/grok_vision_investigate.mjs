/**
 * Grok Vision Investigation - Find working vision models
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

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
// Get all models and filter for vision
// ==========================================
async function listAllModels() {
    log('MODELS', 'Fetching all models...', 'info');
    
    try {
        const res = await fetch(`${ENDPOINT}/models`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        });
        
        const data = await res.json();
        
        if (data.error) {
            log('MODELS', `Error: ${JSON.stringify(data.error)}`, 'error');
            return [];
        }
        
        const models = data.data || [];
        log('MODELS', `Found ${models.length} models:`, 'info');
        
        models.forEach(m => {
            const isVision = m.id.toLowerCase().includes('vision');
            console.log(`  ${isVision ? '👁️ ' : '  '}${m.id}`);
        });
        
        return models.map(m => m.id);
    } catch (err) {
        log('MODELS', `Failed: ${err.message}`, 'error');
        return [];
    }
}

// ==========================================
// Test vision on all models
// ==========================================
async function testVisionOnModels(models) {
    log('VISION', 'Testing vision capability on all models...', 'info');
    
    // Small test image (red square)
    const testImageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpi2r9//38gYGAEESAAEGAAasgJOgzOKCoAAAAASUVORK5CYII=';
    
    const results = [];
    
    for (const model of models) {
        try {
            const body = {
                model: model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'What color is this?' },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/png;base64,${testImageB64}`
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 50
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
                const errMsg = data.error.message || data.error;
                if (errMsg.includes('not supported') || errMsg.includes('does not exist')) {
                    log('VISION', `  ${model}: ❌ No vision support`, 'error');
                    results.push({ model, vision: false, error: errMsg });
                } else {
                    log('VISION', `  ${model}: ⚠️ ${errMsg.substring(0, 60)}`, 'warn');
                    results.push({ model, vision: false, error: errMsg });
                }
            } else {
                const text = data.choices?.[0]?.message?.content || '';
                log('VISION', `  ${model}: ✅ "${text.substring(0, 50)}..."`, 'success');
                results.push({ model, vision: true, response: text });
            }
        } catch (err) {
            log('VISION', `  ${model}: ❌ ${err.message}`, 'error');
            results.push({ model, vision: false, error: err.message });
        }
    }
    
    return results;
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}    Grok Vision Investigation            ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    if (!API_KEY) {
        log('SETUP', 'GROK_API_KEY not found in .env', 'error');
        process.exit(1);
    }
    
    const models = await listAllModels();
    console.log('');
    
    if (models.length > 0) {
        const results = await testVisionOnModels(models);
        
        console.log(`\n${colors.blue}========================================${colors.reset}`);
        console.log(`${colors.blue}         VISION CAPABLE MODELS          ${colors.reset}`);
        console.log(`${colors.blue}========================================${colors.reset}`);
        
        const visionModels = results.filter(r => r.vision);
        if (visionModels.length === 0) {
            console.log('No vision-capable models found with current API key.');
        } else {
            visionModels.forEach(r => {
                console.log(`✅ ${r.model}: ${r.response}`);
            });
        }
    }
}

main().catch(err => {
    log('FATAL', err.message, 'error');
    process.exit(1);
});
