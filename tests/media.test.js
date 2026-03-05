import { expect } from 'chai';
import { Router } from '../src/core/router.js';
import { TicketRegistry } from '../src/core/ticket-registry.js';

function createConfig(overrides = {}) {
    return {
        routing: {
            defaultProvider: 'openai'
        },
        mediaStorage: {
            enabled: false
        },
        providers: {
            openai: {
                type: 'openai',
                endpoint: 'http://localhost:12345/v1',
                model: 'gpt-4o-mini',
                capabilities: {
                    imageGeneration: true,
                    tts: true,
                    stt: true
                }
            }
        },
        ...overrides
    };
}

describe('Phase 2 Media Routing', () => {
    it('rejects image generation when provider lacks capability', async () => {
        const config = createConfig({
            providers: {
                openai: {
                    type: 'openai',
                    endpoint: 'http://localhost:12345/v1',
                    model: 'gpt-4o-mini',
                    capabilities: {
                        imageGeneration: false,
                        tts: true,
                        stt: true
                    }
                }
            }
        });

        const router = new Router(config, null, new TicketRegistry());

        let err;
        try {
            await router.routeImageGeneration({ prompt: 'a cat in watercolor' });
        } catch (error) {
            err = error;
        }

        expect(err).to.exist;
        expect(err.status).to.equal(422);
        expect(err.message).to.include('does not support imageGeneration');
    });

    it('returns async ticket for image generation route', async () => {
        const ticketRegistry = new TicketRegistry();
        const router = new Router(createConfig(), null, ticketRegistry);

        const adapter = router.adapters.get('openai');
        adapter.generateImage = async () => ({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: Buffer.from('fake-image').toString('base64') }]
        });

        const result = await router.routeImageGeneration({ prompt: 'mountain landscape' });

        expect(result).to.have.property('isAsyncTicket', true);
        expect(result.ticketData).to.have.property('ticket');
        expect(ticketRegistry.getTicket(result.ticketData.ticket)).to.exist;
    });

    it('routes TTS synchronously and returns binary metadata', async () => {
        const router = new Router(createConfig(), null, new TicketRegistry());

        const adapter = router.adapters.get('openai');
        adapter.synthesizeSpeech = async () => ({
            audioBuffer: Buffer.from('audio-bytes'),
            contentType: 'audio/mpeg'
        });

        const result = await router.routeAudioSpeech({
            model: 'auto',
            input: 'Hello world',
            voice: 'alloy',
            response_format: 'mp3'
        });

        expect(Buffer.isBuffer(result.audioBuffer)).to.equal(true);
        expect(result.contentType).to.equal('audio/mpeg');
    });
});
