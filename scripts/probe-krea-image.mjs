// Probe: verify OpenRouter krea/krea-2-medium-turbo accepts the
// chat-modalities image pattern (modalities + aspect_ratio) and returns
// images in message.images[].image_url.url. Prints metadata only, never keys.
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const model = config.models['krea-2-image'];
const adapterModel = process.argv[2] || model.adapterModel;

const payload = {
    model: adapterModel,
    prompt: 'A single amber circle centered on a muted teal background, flat minimal graphic',
    aspect_ratio: '1:1'
};

const res = await fetch(`${model.endpoint}/images`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`
    },
    body: JSON.stringify(payload)
});

const text = await res.text();
console.log('HTTP', res.status);

let data;
try { data = JSON.parse(text); } catch { console.log('Non-JSON body:', text.slice(0, 500)); process.exit(1); }

if (data.error) {
    console.log('ERROR:', JSON.stringify(data.error));
    process.exit(1);
}

console.log('top-level keys:', Object.keys(data).join(', '));
const first = Array.isArray(data.data) ? data.data[0] : null;
if (first) {
    console.log('data[0] keys:', Object.keys(first).join(', '));
    if (first.b64_json) console.log('b64 length:', first.b64_json.length);
    if (first.url) console.log('url:', first.url.slice(0, 120));
}
if (data.usage) console.log('usage:', JSON.stringify(data.usage));
