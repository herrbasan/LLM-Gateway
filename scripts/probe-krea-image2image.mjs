// Probe: does krea/krea-2-medium-turbo accept input_references (image-to-image)?
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const model = config.models['krea-2-image'];
const adapterModel = process.argv[2] || model.adapterModel;

// 64x64 solid red PNG, generated offline
const { deflateSync } = await import('node:zlib');
function makeRedPng(size = 64) {
    const raw = Buffer.alloc(size * (size * 3 + 1));
    for (let y = 0; y < size; y++) {
        const row = y * (size * 3 + 1);
        raw[row] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            raw[row + 1 + x * 3] = 255;     // R
            raw[row + 2 + x * 3] = 0;       // G
            raw[row + 3 + x * 3] = 0;       // B
        }
    }
    const idat = deflateSync(raw);
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crcTable = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
        let crc = 0xFFFFFFFF;
        for (const b of body) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
        const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc >>> 0);
        return Buffer.concat([len, body, crcBuf]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
    ]);
}

const photoRes = await fetch('https://picsum.photos/512');
const photoBuf = Buffer.from(await photoRes.arrayBuffer());
const dataUrl = `data:image/jpeg;base64,${photoBuf.toString('base64')}`;
console.log(`reference photo: ${photoBuf.length} bytes`);

const variants = [
    [{ type: 'image_url', image_url: { url: dataUrl } }]
];

for (const input_references of variants) {
    const payload = {
        model: adapterModel,
        prompt: 'Same image, but shift the dominant color to deep blue',
        aspect_ratio: '1:1',
        input_references
    };
    const shape = JSON.stringify(input_references[0]).replace(/data:image[^"]+/, 'DATAURL');
    const res = await fetch(`${model.endpoint}/images`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${model.apiKey}`
        },
        body: JSON.stringify(payload)
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (data?.error) {
        console.log(`${res.status} ${shape} -> ERROR: ${JSON.stringify(data.error).slice(0, 200)}`);
    } else if (data?.data?.length) {
        console.log(`${res.status} ${shape} -> OK, b64 length ${data.data[0].b64_json?.length}, cost ${data.usage?.cost}`);
        break;
    } else {
        console.log(`${res.status} ${shape} -> ${text.slice(0, 200)}`);
    }
}
process.exit(0);
