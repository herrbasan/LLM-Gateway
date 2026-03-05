/**
 * Grok Vision - Testing different parameter combinations for grok-4
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

// Test image
const testImageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpi2r9//38gYGAEESAAEGAAasgJOgzOKCoAAAAASUVORK5CYII=';

async function testWithParams(model, body, description) {
    try {
        log('TEST', `${model} - ${description}...`, 'info');
        
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
            log('TEST', `  ❌ ${data.error.message || data.error}`, 'error');
            return false;
        } else {
            const text = data.choices?.[0]?.message?.content || '';
            log('TEST', `  ✅ "${text.substring(0, 80)}..."`, 'success');
            return true;
        }
    } catch (err) {
        log('TEST', `  ❌ ${err.message}`, 'error');
        return false;
    }
}

async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}    Grok Vision Parameter Testing        ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    const model = 'grok-4-fast-non-reasoning';
    
    // Test 1: Standard OpenAI format with image_url
    await testWithParams(model, {
        model: model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What color is this?' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${testImageB64}` } }
                ]
            }
        ]
    }, 'Standard OpenAI format with image_url');
    
    // Test 2: Without max_tokens
    await testWithParams(model, {
        model: model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What color is this?' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${testImageB64}` } }
                ]
            }
        ]
    }, 'Without max_tokens');
    
    // Test 3: Simple text-only first
    await testWithParams(model, {
        model: model,
        messages: [{ role: 'user', content: 'What is 2+2?' }]
    }, 'Text-only baseline');
    
    // Test 4: Grok 3 with text for comparison
    await testWithParams('grok-3', {
        model: 'grok-3',
        messages: [{ role: 'user', content: 'What is 2+2?' }]
    }, 'Grok-3 text-only baseline');
    
    console.log(`\n${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}    Documentation Check                  ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}`);
    
    log('INFO', 'According to xAI docs:', 'info');
    log('INFO', '- grok-2-vision-1212 is the documented vision model', 'info');
    log('INFO', '- Our API key does not have access to grok-2-vision-1212', 'info');
    log('INFO', '- grok-4 models may have vision but need different API key tier', 'info');
}

main().catch(err => {
    log('FATAL', err.message, 'error');
    process.exit(1);
});
