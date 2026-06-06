/**
 * SSE debug probe — mimics Copilot's BYOK request and logs every SSE chunk.
 * Usage: node scripts/sse_probe.mjs
 */
const BASE = 'http://localhost:3400';

const body = {
    model: 'deepseek-chat',
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.1,
    messages: [
        { role: 'system', content: 'You are a helpful assistant. Be concise.' },
        { role: 'user', content: 'Say "hello" and count to 3.' }
    ]
};

const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

console.log(`Status: ${res.status}`);
console.log(`Content-Type: ${res.headers.get('content-type')}\n`);

const decoder = new TextDecoder();
let buffer = '';

// Read SSE stream
for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
                console.log('--- [DONE] ---');
            } else {
                try {
                    const parsed = JSON.parse(data);
                    const hasUsage = parsed.usage ? ' [USAGE]' : '';
                    const hasChoices = parsed.choices?.length > 0 ? ` [CHOICES:${parsed.choices.length}]` : ' [CHOICES:0]';
                    const content = parsed.choices?.[0]?.delta?.content;
                    const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
                    const finishReason = parsed.choices?.[0]?.finish_reason;
                    
                    let label = '';
                    if (content) label += ` content:"${content.substring(0, 40)}"`;
                    if (toolCalls) label += ` tool_calls:${toolCalls.length}`;
                    if (finishReason) label += ` finish:${finishReason}`;
                    if (parsed.usage) label += ` usage:${JSON.stringify(parsed.usage)}`;
                    
                    console.log(`${hasUsage}${hasChoices}${label}`);
                } catch {
                    console.log(`[RAW] ${line}`);
                }
            }
        } else if (line.trim() && !line.startsWith(':')) {
            console.log(`[OTHER] ${line}`);
        }
    }
}

console.log('\nDone.');
