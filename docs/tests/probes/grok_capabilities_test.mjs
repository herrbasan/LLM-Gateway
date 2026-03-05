/**
 * Test complete Grok capability mapping
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const API_KEY = process.env.GROK_API_KEY;

async function testCapabilityMapping() {
    console.log('Testing Grok capability mapping...\n');
    
    // Fetch models
    let modelsList = [];
    try {
        const res = await fetch('https://api.x.ai/v1/models', {
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        });
        const data = await res.json();
        modelsList = data.data || [];
    } catch (err) {
        console.log(`API fetch failed: ${err.message}`);
    }
    
    // Apply adapter logic
    if (modelsList.length === 0) {
        modelsList.push(
            { id: 'grok-3' },
            { id: 'grok-3-mini' },
            { id: 'grok-4-fast-non-reasoning' }
        );
    }
    
    const hasImageGen = modelsList.some(m => m.id.includes('imagine'));
    if (!hasImageGen) {
        modelsList.push(
            { id: 'grok-imagine-image' },
            { id: 'grok-imagine-image-pro' },
            { id: 'grok-imagine-video' }
        );
    }
    
    // Pattern matching (from adapter)
    const embeddingPatterns = ['embed', 'embedding'];
    const imageGenPatterns = ['dall-e', 'imagen', 'imagine', '-image', 'image-', 'imagegen', 'image-edit', 'cogview', 'wanx', 'flux'];
    const ttsPatterns = ['text-to-speech', 'tts', 'speech', 'audio'];
    const sttPatterns = ['whisper', 'transcribe', 'asr', 'speech-to-text', 'stt', 'audio'];
    
    console.log('--- Capability Summary ---\n');
    
    const capabilities = {
        chat: [],
        imageGeneration: [],
        tts: [],
        stt: [],
        embedding: []
    };
    
    modelsList.forEach(m => {
        const id = m.id.toLowerCase();
        const isEmbedding = embeddingPatterns.some(p => id.includes(p));
        const isImageGeneration = imageGenPatterns.some(p => id.includes(p));
        const isTts = ttsPatterns.some(p => id.includes(p));
        const isStt = sttPatterns.some(p => id.includes(p));
        const isTextChat = !isEmbedding && !isImageGeneration && !isTts && !isStt;
        
        const result = {
            id: m.id,
            capabilities: {
                chat: isTextChat,
                embeddings: isEmbedding,
                imageGeneration: isImageGeneration,
                tts: isTts,
                stt: isStt
            }
        };
        
        if (isTextChat) capabilities.chat.push(m.id);
        if (isImageGeneration) capabilities.imageGeneration.push(m.id);
        if (isTts) capabilities.tts.push(m.id);
        if (isStt) capabilities.stt.push(m.id);
        if (isEmbedding) capabilities.embedding.push(m.id);
    });
    
    console.log(`Chat Models (${capabilities.chat.length}):`);
    capabilities.chat.forEach(id => console.log(`  - ${id}`));
    
    console.log(`\nImage Generation Models (${capabilities.imageGeneration.length}):`);
    capabilities.imageGeneration.forEach(id => console.log(`  - ${id}`));
    
    console.log(`\nTTS Models (${capabilities.tts.length}):`);
    if (capabilities.tts.length === 0) console.log('  (none)');
    else capabilities.tts.forEach(id => console.log(`  - ${id}`));
    
    console.log(`\nSTT Models (${capabilities.stt.length}):`);
    if (capabilities.stt.length === 0) console.log('  (none)');
    else capabilities.stt.forEach(id => console.log(`  - ${id}`));
    
    console.log(`\nEmbedding Models (${capabilities.embedding.length}):`);
    if (capabilities.embedding.length === 0) console.log('  (none)');
    else capabilities.embedding.forEach(id => console.log(`  - ${id}`));
}

testCapabilityMapping();
