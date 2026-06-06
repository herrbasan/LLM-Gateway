/**
 * Copilot Wiretap — proxy between Copilot and gateway to capture exact traffic.
 * Run: node scripts/copilot_tap.mjs
 * Then point Copilot at http://localhost:3401 instead of http://localhost:3400
 */
import { createServer } from 'node:http';

const GATEWAY = 'http://localhost:3400';
const TAP_PORT = 3401;

let requestCount = 0;

const server = createServer(async (req, res) => {
    const reqId = ++requestCount;
    const method = req.method;
    const url = req.url;
    
    // Read body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    
    // Log the request
    console.log(`\n=== REQUEST #${reqId} === ${method} ${url}`);
    if (url === '/v1/chat/completions' && body.length > 0) {
        try {
            const parsed = JSON.parse(body.toString());
            console.log(`model: ${parsed.model}`);
            console.log(`stream: ${parsed.stream}`);
            console.log(`stream_options: ${JSON.stringify(parsed.stream_options)}`);
            console.log(`message count: ${parsed.messages?.length}`);
        } catch {}
    } else if (url === '/v1/models') {
        console.log(`(model listing request)`);
    }

    // Forward to gateway
    const targetUrl = `${GATEWAY}${url}`;
    const fetchRes = await fetch(targetUrl, {
        method,
        headers: Object.fromEntries(
            Object.entries(req.headers).filter(([k]) => 
                !['host', 'connection'].includes(k.toLowerCase())
            )
        ),
        body: body.length > 0 ? body : undefined,
    });

    // Copy headers
    res.statusCode = fetchRes.status;
    for (const [k, v] of fetchRes.headers) {
        res.setHeader(k, v);
    }
    res.flushHeaders();

    // If SSE stream, log chunks
    const ct = fetchRes.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
        console.log(`\n--- SSE STREAM #${reqId} ---`);
        const reader = fetchRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const text = decoder.decode(value, { stream: true });
                buffer += text;
                
                const lines = buffer.split('\n');
                buffer = lines.pop();
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') {
                            console.log('--- [DONE] ---');
                        } else {
                            try {
                                const parsed = JSON.parse(data);
                                if (parsed.usage) {
                                    console.log(`[USAGE] choices:${parsed.choices?.length ?? '?'} usage:${JSON.stringify(parsed.usage)}`);
                                } else if (parsed.choices?.[0]?.finish_reason) {
                                    console.log(`[FINISH] ${parsed.choices[0].finish_reason}`);
                                } else if (parsed.choices?.[0]?.delta?.content) {
                                    const c = parsed.choices[0].delta.content;
                                    console.log(`[TEXT] "${c.substring(0, 60)}${c.length > 60 ? '...' : ''}"`);
                                } else if (parsed.choices?.[0]?.delta?.tool_calls) {
                                    console.log(`[TOOL] ${parsed.choices[0].delta.tool_calls.length} calls`);
                                }
                            } catch { /* raw */ }
                        }
                    }
                }
                
                // Forward
                res.write(value);
            }
        } catch (err) {
            console.log(`[STREAM ERROR] ${err.message}`);
        } finally {
            reader.releaseLock();
            res.end();
        }
    } else {
        // Not SSE — pipe directly
        const body = await fetchRes.arrayBuffer();
        if (url === '/v1/models') {
            try {
                const parsed = JSON.parse(Buffer.from(body).toString());
                const deepseekModel = parsed.data?.find(m => m.id === 'deepseek-chat');
                if (deepseekModel) {
                    console.log(`model metadata for deepseek-chat: ${JSON.stringify(deepseekModel, null, 2)}`);
                }
            } catch {}
        }
        res.end(Buffer.from(body));
    }
    
    console.log(`=== END #${reqId} ===\n`);
});

server.listen(TAP_PORT, () => {
    console.log(`Wiretap running on http://localhost:${TAP_PORT}`);
    console.log(`Point Copilot at this port. Ctrl+C to stop.`);
});
