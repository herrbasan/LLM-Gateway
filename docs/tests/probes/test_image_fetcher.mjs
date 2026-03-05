/**
 * Test ImageFetcher Utility
 */
import { ImageFetcher } from '../../../src/utils/image-fetcher.js';

const fetcher = new ImageFetcher({
    maxSize: 5 * 1024 * 1024, // 5MB for testing
    timeout: 10000
});

async function runTests() {
    console.log('=== ImageFetcher Tests ===\n');

    // Test 1: Data URL detection
    console.log('Test 1: Data URL detection');
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAA';
    console.log(`  Is data URL: ${fetcher.isDataUrl(dataUrl)} (expected: true)`);
    console.log(`  Is http URL: ${fetcher.isDataUrl('http://example.com')} (expected: false)`);

    // Test 2: Parse data URL
    console.log('\nTest 2: Parse data URL');
    const parsed = fetcher.parseDataUrl(dataUrl);
    console.log(`  MIME type: ${parsed.mimeType} (expected: image/png)`);

    // Test 3: URL validation - private IPs
    console.log('\nTest 3: Private IP blocking');
    const privateUrls = [
        'http://localhost/image.png',
        'http://127.0.0.1/image.png',
        'http://192.168.1.1/image.png',
        'http://10.0.0.1/image.png'
    ];
    for (const url of privateUrls) {
        try {
            fetcher.validateUrl(url);
            console.log(`  FAIL: ${url} should have been blocked`);
        } catch (e) {
            console.log(`  OK: ${url} blocked (${e.message})`);
        }
    }

    // Test 4: URL validation - allowed URLs
    console.log('\nTest 4: Allowed URLs');
    const allowedUrls = [
        'https://example.com/image.png',
        'http://public-site.com/photo.jpg'
    ];
    for (const url of allowedUrls) {
        try {
            fetcher.validateUrl(url);
            console.log(`  OK: ${url} allowed`);
        } catch (e) {
            console.log(`  FAIL: ${url} should be allowed (${e.message})`);
        }
    }

    // Test 5: Fetch remote image (if available)
    console.log('\nTest 5: Fetch remote image');
    try {
        // Use a reliable test image
        const result = await fetcher.fetchImage('https://via.placeholder.com/150');
        console.log(`  OK: Fetched ${result.size} bytes, type: ${result.mimeType}`);
    } catch (e) {
        console.log(`  SKIP: ${e.message} (network issue or test image unavailable)`);
    }

    // Test 6: Data URL passthrough
    console.log('\nTest 6: Data URL passthrough');
    const testImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD';
    const result = await fetcher.fetchImage(testImage);
    console.log(`  OK: Parsed data URL, type: ${result.mimeType}`);

    console.log('\n=== Tests Complete ===');
}

runTests().catch(console.error);
