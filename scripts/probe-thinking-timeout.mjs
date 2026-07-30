// Probe: measure first-byte vs mid-stream timing for a thinking-heavy DeepSeek request.
// Determines whether the observed timeout is the gateway's 60s first-byte deadline
// or the 120s per-read stream deadline.
const prompt = 'Think step by step at great length: derive whether 5777 is prime. Show all reasoning in detail before answering.';

const body = JSON.stringify({
  model: 'deepseek-chat',
  stream: true,
  max_tokens: 2000,
  messages: [{ role: 'user', content: prompt }]
});

const start = Date.now();
const elapsed = () => Date.now() - start;

let firstByteAt = null;
let chunkCount = 0;
let lastChunkAt = null;
let sawReasoning = false;
let sawContent = false;
let errorLine = null;

try {
  const res = await fetch('http://localhost:3400/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Authorization': 'Bearer someKey33!!'
    },
    body
  });

  firstByteAt = elapsed();
  console.log(`HEADERS at ${firstByteAt}ms  status=${res.status} ${res.headers.get('content-type')}`);

  if (!res.ok) {
    const text = await res.text();
    console.log(`ERROR BODY: ${text.slice(0, 500)}`);
    process.exit(0);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = elapsed();
    const gap = lastChunkAt === null ? 0 : now - lastChunkAt;
    if (gap > 20000) console.log(`  LARGE GAP ${gap}ms before chunk #${chunkCount + 1} at ${now}ms`);
    lastChunkAt = now;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      chunkCount++;
      try {
        const obj = JSON.parse(data);
        if (obj.error) { errorLine = JSON.stringify(obj.error).slice(0, 300); }
        const delta = obj.choices?.[0]?.delta;
        if (delta?.reasoning_content) sawReasoning = true;
        if (delta?.content) sawContent = true;
        if (obj.choices?.[0]?.finish_reason) console.log(`  finish_reason=${obj.choices[0].finish_reason} at ${now}ms`);
      } catch {}
    }
  }
  console.log(`DONE at ${elapsed()}ms — ${chunkCount} chunks, reasoning=${sawReasoning}, content=${sawContent}`);
  if (errorLine) console.log(`IN-BAND ERROR: ${errorLine}`);
} catch (e) {
  console.log(`EXCEPTION at ${elapsed()}ms (firstByte=${firstByteAt}): ${e.name}: ${e.message} code=${e.code ?? e.cause?.code ?? 'n/a'}`);
}
