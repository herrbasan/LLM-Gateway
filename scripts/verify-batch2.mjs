// Verify P0 batch-2 fixes: retry policy, first-byte timeout, SSRF redirect guard.
// Exits 0 on all-pass, 1 on any failure. Uses local throwaway HTTP servers.
import assert from 'node:assert';
import http from 'node:http';
import { request as httpRequest } from '../src/utils/http.js';
import { ImageFetcher } from '../src/utils/image-fetcher.js';

let failures = 0;
const check = (name, fn) => {
    try { fn(); console.log(`PASS  ${name}`); }
    catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
};

// Helper: spin a server, run fn, always close.
async function withServer(handler, fn) {
    const server = http.createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try { return await fn(port); }
    finally { await new Promise(r => server.close(r)); }
}

// --- 1. 429 is NOT retried (surfaces immediately) ---
{
    let calls = 0;
    await withServer((req, res) => { calls++; res.writeHead(429); res.end('rate limited'); }, async (port) => {
        let status = null;
        try { await httpRequest(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}' }); }
        catch (err) { status = err.status; }
        check('429 surfaces without retry', () => {
            assert.strictEqual(status, 429);
            assert.strictEqual(calls, 1, `expected 1 call, got ${calls}`);
        });
    });
}

// --- 2. 503 IS retried then succeeds ---
{
    let calls = 0;
    await withServer((req, res) => {
        calls++;
        if (calls < 3) { res.writeHead(503); res.end('unavailable'); }
        else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }
    }, async (port) => {
        const res = await httpRequest(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}', retry: { baseDelayMs: 10 } });
        const data = await res.json();
        check('503 retried until success', () => {
            assert.strictEqual(data.ok, true);
            assert.strictEqual(calls, 3, `expected 3 calls, got ${calls}`);
        });
    });
}

// --- 3. First-byte timeout fires on a hung upstream ---
{
    await withServer((req, res) => { /* never respond */ }, async (port) => {
        const start = Date.now();
        let code = null;
        try {
            await httpRequest(`http://127.0.0.1:${port}/hang`, {
                method: 'POST', body: '{}',
                retry: { maxRetries: 0, firstByteTimeoutMs: 300 }
            });
        } catch (err) { code = err.code; }
        const elapsed = Date.now() - start;
        check('first-byte timeout detects hung upstream', () => {
            assert.strictEqual(code, 'UPSTREAM_TIMEOUT', `got ${code}`);
            assert.ok(elapsed < 2000, `took ${elapsed}ms`);
        });
    });
}

// --- 4. SSRF: redirect to a private IP is blocked ---
{
    const fetcher = new ImageFetcher();
    await withServer((req, res) => {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
        res.end();
    }, async (port) => {
        let errMsg = '';
        try { await fetcher.fetchImage(`http://127.0.0.1:${port}/redirect`); }
        catch (err) { errMsg = err.message; }
        check('SSRF redirect to metadata IP blocked', () => {
            // 127.0.0.1 is itself private → blocked at initial validateUrl.
            // So assert the block fired (message about private IP), proving
            // the validation runs. The redirect target never gets fetched.
            assert.ok(errMsg.length > 0, 'expected an error');
            assert.ok(/Private IP/i.test(errMsg), `unexpected: ${errMsg}`);
        });
    });
}

// --- 5. SSRF: redirect target validated (public start, private redirect target) ---
{
    // Build a fetcher whose validateUrl would allow the start host but whose
    // redirect target is private. We simulate by directly testing the hop
    // validator with a server that redirects to a private address, while
    // allowing the start host through a stubbed validateUrl.
    const fetcher = new ImageFetcher();
    const realValidate = fetcher.validateUrl.bind(fetcher);
    // Allow 127.0.0.1 as the "public" start for this test only.
    fetcher.validateUrl = (u) => {
        const p = new URL(u);
        if (p.hostname === '127.0.0.1') return p;      // treat start as allowed
        return realValidate(u);                          // everything else real rules
    };
    await withServer((req, res) => {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
        res.end();
    }, async (port) => {
        let errMsg = '';
        try { await fetcher.fetchWithRedirectValidation(`http://127.0.0.1:${port}/r`); }
        catch (err) { errMsg = err.message; }
        check('redirect target re-validated (private target blocked mid-hop)', () => {
            assert.ok(/Private IP/i.test(errMsg), `unexpected: ${errMsg}`);
        });
    });
}

console.log(failures === 0 ? 'BATCH2_VERIFY_PASS' : `BATCH2_VERIFY_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
