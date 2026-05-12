// Tests whether dimensions parameter is forwarded to embedding providers
// Run: node test-dimensions.js

const GATEWAY_URL = 'http://192.168.0.100:3400/v1/embeddings';
const MODEL = 'or-qwen-embed';

async function test() {
    // Test 1: request-level dimensions (highest priority)
    console.log('Test 1: request.dimensions=2560');
    const r1 = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: ['test'], dimensions: 2560 })
    });
    const d1 = await r1.json();
    console.log('  status:', r1.status);
    console.log('  dims:', d1.data?.[0]?.embedding?.length || JSON.stringify(d1).slice(0, 100));
    console.log('  PASS:', d1.data?.[0]?.embedding?.length === 2560);
    console.log('');

    // Test 2: no dimensions (should use capabilities.dimensions fallback)
    console.log('Test 2: no dimensions param');
    const r2 = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: ['test'] })
    });
    const d2 = await r2.json();
    console.log('  status:', r2.status);
    console.log('  dims:', d2.data?.[0]?.embedding?.length || JSON.stringify(d2).slice(0, 100));
    console.log('  PASS:', d2.data?.[0]?.embedding?.length === 2560);
    console.log('');

    // Test 3: request-level override (request.dimensions should override capabilities)
    console.log('Test 3: request.dimensions=512 (override capabilities.dimensions=2560)');
    const r3 = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: ['test'], dimensions: 512 })
    });
    const d3 = await r3.json();
    console.log('  status:', r3.status);
    console.log('  dims:', d3.data?.[0]?.embedding?.length || JSON.stringify(d3).slice(0, 100));
    console.log('  PASS:', d3.data?.[0]?.embedding?.length === 512);
}

test().catch(e => console.error('Fatal:', e.message));
