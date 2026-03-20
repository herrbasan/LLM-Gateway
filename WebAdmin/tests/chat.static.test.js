const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { expect } = require('chai');

const { createApp } = require('../server');

describe('WebAdmin Embedded Chat Routes', () => {
    it('serves the embedded chat client from /chat/', async () => {
        const app = createApp();

        const res = await request(app).get('/chat/');

        expect(res.status).to.equal(200);
        expect(res.headers['cache-control']).to.include('no-store');
        expect(res.text).to.include('<title>LLM Gateway Chat</title>');
        expect(res.text).to.include('<script src="js/config.js"></script>');
        expect(res.text).to.include('<script src="/NUI/nui.js" type="module"></script>');
        expect(res.text).to.include('<script src="/NUI/lib/modules/nui-lightbox.js" type="module"></script>');
        expect(res.text).to.include('<script src="/shared/vendor/prism.js"></script>');
    });

    it('serves the chat config file from the embedded submodule', async () => {
        const app = createApp();
        const expected = fs.readFileSync(
            path.join(__dirname, '..', 'LLM-Gateway-Chat', 'chat', 'js', 'config.js'),
            'utf8'
        );

        const res = await request(app).get('/chat/js/config.js');

        expect(res.status).to.equal(200);
        expect(res.headers['cache-control']).to.include('no-store');
        expect(res.headers['content-type']).to.include('application/javascript');
        expect(res.text).to.equal(expected);
    });

    it('serves chat sibling assets from the embedded submodule', async () => {
        const app = createApp();

        const sharedRes = await request(app).get('/shared/vendor/prism.css');
        const nuiRes = await request(app).get('/NUI/lib/modules/nui-lightbox.js');

        expect(sharedRes.status).to.equal(200);
        expect(sharedRes.headers['content-type']).to.include('text/css');
        expect(nuiRes.status).to.equal(200);
        expect(nuiRes.headers['content-type']).to.match(/javascript|ecmascript/);
    });

    it('serves the legacy /nui_wc2/NUI module path for stale cached chat pages', async () => {
        const app = createApp();

        const res = await request(app).get('/nui_wc2/NUI/lib/modules/nui-lightbox.js');

        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.match(/javascript|ecmascript/);
    });
});