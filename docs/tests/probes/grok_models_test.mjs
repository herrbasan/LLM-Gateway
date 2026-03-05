/**
 * Test Grok model listing with image generation models
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const API_KEY = process.env.GROK_API_KEY;

// Simulate the openai adapter logic
async function testGrokModelListing() {
    console.log('Testing Grok model listing logic...\n');
    
    // Fetch models from API
    let modelsList = [];
    try {
        const res = await fetch('https://api.x.ai/v1/models', {
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        });
        const data = await res.json();
        modelsList = data.data || [];
        console.log(`API returned ${modelsList.length} models`);
    } catch (err) {
        console.log(`API fetch failed: ${err.message}`);
    }
    
    // Apply adapter logic
    const config = { providerName: 'grok' };
    
    if (modelsList.length === 0) {
        modelsList.push(
            { id: 'grok-3' },
            { id: 'grok-3-mini' },
            { id: 'grok-4-fast-non-reasoning' }
        );
    }
    
    // Inject image generation models if not returned by API
    const hasImageGen = modelsList.some(m => m.id.includes('imagine'));
    if (!hasImageGen) {
        modelsList.push(
            { id: 'grok-imagine-image' },
            { id: 'grok-imagine-image-pro' },
            { id: 'grok-imagine-video' }
        );
    }
    
    // Pattern matching (from adapter)
    const imageGenPatterns = ['dall-e', 'imagen', 'imagine', '-image', 'image-', 'imagegen', 'image-edit', 'cogview', 'wanx', 'flux'];
    
    console.log('\n--- All Models ---');
    modelsList.forEach(m => {
        const id = m.id.toLowerCase();
        const isImageGen = imageGenPatterns.some(p => id.includes(p));
        console.log(`${isImageGen ? '🖼️ ' : '  '}${m.id}${isImageGen ? ' (imageGeneration)' : ''}`);
    });
    
    console.log('\n--- Image Generation Models ---');
    const imageGenModels = modelsList.filter(m => {
        const id = m.id.toLowerCase();
        return imageGenPatterns.some(p => id.includes(p));
    });
    
    if (imageGenModels.length === 0) {
        console.log('No image generation models found!');
    } else {
        imageGenModels.forEach(m => console.log(`  ✅ ${m.id}`));
    }
}

testGrokModelListing();
