/**
 * Vision Capability Discovery Test
 * Verifies that /v1/models correctly exposes vision capabilities
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const colors = {
    reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m'
};

function log(section, message, type = 'info') {
    const color = type === 'success' ? colors.green : type === 'error' ? colors.red : type === 'warn' ? colors.yellow : colors.cyan;
    console.log(`${color}[${section}]${colors.reset} ${message}`);
}

async function testProviderModels(providerName, endpoint, apiKey, type = 'openai') {
    log('TEST', `Testing ${providerName}...`, 'section');
    
    try {
        const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
        const res = await fetch(`${endpoint}/models`, { headers });
        const data = await res.json();
        
        if (data.error) {
            log('ERROR', `${providerName}: ${JSON.stringify(data.error)}`, 'error');
            return null;
        }
        
        const models = data.data || [];
        log('INFO', `${providerName}: ${models.length} models found`, 'info');
        
        // Check vision capabilities
        const visionModels = models.filter(m => m.capabilities?.vision === true);
        const chatModels = models.filter(m => m.capabilities?.chat === true);
        
        console.log(`  Chat models: ${chatModels.length}`);
        console.log(`  Vision models: ${visionModels.length}`);
        
        if (visionModels.length > 0) {
            console.log(`  Vision-capable models:`);
            visionModels.forEach(m => console.log(`    - ${m.id}`));
        } else {
            log('WARN', `  No models with vision: true!`, 'warn');
        }
        
        return { provider: providerName, total: models.length, vision: visionModels.length, models };
    } catch (err) {
        log('ERROR', `${providerName}: ${err.message}`, 'error');
        return null;
    }
}

async function main() {
    console.log(`${colors.blue}========================================${colors.reset}`);
    console.log(`${colors.blue}  Vision Capability Discovery Test      ${colors.reset}`);
    console.log(`${colors.blue}========================================${colors.reset}\n`);
    
    // Test Gemini
    await testProviderModels(
        'Gemini',
        'https://generativelanguage.googleapis.com/v1beta',
        process.env.GEMINI_API_KEY
    );
    
    console.log('');
    
    // Test Grok
    await testProviderModels(
        'Grok',
        'https://api.x.ai/v1',
        process.env.GROK_API_KEY
    );
    
    console.log('');
    
    // Test local LMStudio (if available)
    try {
        await testProviderModels(
            'LMStudio',
            'http://localhost:12345/v1',
            null
        );
    } catch (e) {
        log('WARN', 'LMStudio not running locally', 'warn');
    }
}

main();
