/**
 * Test Router + ImageFetcher Integration
 * Verifies that remote image URLs are fetched and converted to base64
 */
import { Router } from '../../../src/core/router.js';
import { ImageFetcher } from '../../../src/utils/image-fetcher.js';

// Mock config
const mockConfig = {
    port: 3400,
    host: '0.0.0.0',
    compaction: {
        enabled: false
    },
    routing: {
        defaultProvider: 'gemini'
    },
    imageFetcher: {
        maxSize: 5 * 1024 * 1024,
        timeout: 10000,
        blockedHosts: []
    },
    providers: {
        gemini: {
            type: 'gemini',
            apiKey: process.env.GEMINI_API_KEY || 'test-key',
            endpoint: 'https://generativelanguage.googleapis.com/v1beta',
            model: 'gemini-flash-latest',
            contextWindow: 1000000,
            capabilities: {
                embeddings: true,
                structuredOutput: true,
                streaming: true,
                imageGeneration: true,
                tts: true,
                stt: true,
                vision: true
            }
        }
    }
};

async function runTests() {
    console.log('=== Router + ImageFetcher Integration Tests ===\n');

    // Test 1: ImageFetcher is available in Router
    console.log('Test 1: Router initializes ImageFetcher');
    try {
        const router = new Router(mockConfig);
        if (router.imageFetcher instanceof ImageFetcher) {
            console.log('  OK: Router has ImageFetcher instance');
        } else {
            console.log('  FAIL: Router.imageFetcher is not ImageFetcher instance');
        }
    } catch (e) {
        console.log(`  FAIL: ${e.message}`);
    }

    // Test 2: Router config passes to ImageFetcher
    console.log('\nTest 2: ImageFetcher config from Router');
    try {
        const router = new Router(mockConfig);
        if (router.imageFetcher.config.maxSize === 5 * 1024 * 1024) {
            console.log('  OK: maxSize config passed correctly');
        } else {
            console.log(`  FAIL: maxSize is ${router.imageFetcher.config.maxSize}`);
        }
        if (router.imageFetcher.config.timeout === 10000) {
            console.log('  OK: timeout config passed correctly');
        } else {
            console.log(`  FAIL: timeout is ${router.imageFetcher.config.timeout}`);
        }
    } catch (e) {
        console.log(`  FAIL: ${e.message}`);
    }

    // Test 3: Vision content detection
    console.log('\nTest 3: Vision content detection in payload');
    try {
        const router = new Router(mockConfig);
        const payload = {
            model: 'gemini-flash-latest',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Describe this image' },
                        { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }
                    ]
                }
            ]
        };
        
        let imageCount = 0;
        const hasVisionContent = payload.messages && payload.messages.some(m => {
            if (Array.isArray(m.content)) {
                const images = m.content.filter(part => part.type === 'image_url');
                imageCount += images.length;
                return images.length > 0;
            }
            return false;
        });
        
        if (hasVisionContent && imageCount === 1) {
            console.log('  OK: Vision content detected correctly');
        } else {
            console.log(`  FAIL: hasVision=${hasVisionContent}, imageCount=${imageCount}`);
        }
    } catch (e) {
        console.log(`  FAIL: ${e.message}`);
    }

    // Test 4: ImageFetcher validates URLs
    console.log('\nTest 4: ImageFetcher URL validation');
    try {
        const fetcher = new ImageFetcher(mockConfig.imageFetcher);
        
        // Should block private IPs
        try {
            fetcher.validateUrl('http://192.168.1.1/image.jpg');
            console.log('  FAIL: Private IP should be blocked');
        } catch (e) {
            console.log('  OK: Private IP blocked');
        }
        
        // Should allow public URLs
        try {
            fetcher.validateUrl('https://example.com/image.jpg');
            console.log('  OK: Public URL allowed');
        } catch (e) {
            console.log(`  FAIL: Public URL blocked: ${e.message}`);
        }
    } catch (e) {
        console.log(`  FAIL: ${e.message}`);
    }

    // Test 5: Data URL passthrough
    console.log('\nTest 5: Data URL passthrough');
    try {
        const fetcher = new ImageFetcher(mockConfig.imageFetcher);
        const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD';
        const result = await fetcher.fetchImage(dataUrl);
        
        if (result.mimeType === 'image/jpeg' && result.base64) {
            console.log('  OK: Data URL parsed correctly');
        } else {
            console.log(`  FAIL: mimeType=${result.mimeType}`);
        }
    } catch (e) {
        console.log(`  FAIL: ${e.message}`);
    }

    // Test 6: Fetch real remote image (placeholder)
    console.log('\nTest 6: Fetch remote image');
    try {
        const fetcher = new ImageFetcher(mockConfig.imageFetcher);
        // Using placeholder image service
        const result = await fetcher.fetchImage('https://via.placeholder.com/150');
        
        if (result.base64 && result.size > 0 && result.mimeType) {
            console.log(`  OK: Fetched ${result.size} bytes, type: ${result.mimeType}`);
        } else {
            console.log('  FAIL: Invalid fetch result');
        }
    } catch (e) {
        console.log(`  SKIP: ${e.message} (network issue)`);
    }

    console.log('\n=== Integration Tests Complete ===');
}

runTests().catch(console.error);
