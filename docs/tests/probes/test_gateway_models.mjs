/**
 * Test Gateway /v1/models Endpoint
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const GATEWAY_URL = 'http://localhost:3400';

async function testGatewayModels() {
    console.log('Testing Gateway /v1/models...\n');
    
    try {
        const res = await fetch(`${GATEWAY_URL}/v1/models`);
        const data = await res.json();
        
        if (data.error) {
            console.error('Error:', data.error);
            return;
        }
        
        console.log(`Total models: ${data.data.length}\n`);
        
        // Count by capability
        const visionModels = data.data.filter(m => m.capabilities?.vision);
        const chatModels = data.data.filter(m => m.capabilities?.chat);
        
        console.log(`Vision-capable: ${visionModels.length}`);
        console.log(`Chat-capable: ${chatModels.length}\n`);
        
        // Group by provider
        const byProvider = {};
        data.data.forEach(m => {
            const p = m.provider || 'unknown';
            if (!byProvider[p]) byProvider[p] = [];
            byProvider[p].push(m);
        });
        
        console.log('By Provider:');
        Object.entries(byProvider).forEach(([provider, models]) => {
            const vCount = models.filter(m => m.capabilities?.vision).length;
            console.log(`  ${provider}: ${models.length} models (${vCount} vision)`);
        });
        
        // Show sample models
        console.log('\nSample vision models:');
        visionModels.slice(0, 5).forEach(m => {
            console.log(`  - ${m.id} (${m.provider})`);
        });
        
    } catch (err) {
        console.error('Failed to connect to gateway:', err.message);
        console.log('Make sure the gateway is running on port 3400');
    }
}

testGatewayModels();
