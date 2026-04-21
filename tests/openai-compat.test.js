import { expect } from 'chai';
import EventEmitter from 'node:events';
import { chatCompletionsToResponse, convertStreamToResponseEvents } from '../src/utils/response-format.js';
import { normalizeResponse, normalizeStreamChunk } from '../src/utils/response-normalizer.js';
import { createResponsesHandler } from '../src/routes/responses.js';
import { createChatHandler } from '../src/routes/chat.js';

class MockResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.body = '';
        this.writableEnded = false;
        this.statusCode = 200;
        this.payload = null;
    }
    setHeader(key, value) { this.headers[key] = value; }
    flushHeaders() {}
    write(chunk) { this.body += chunk; return true; }
    status(code) { this.statusCode = code; return this; }
    json(payload) { this.payload = payload; this.writableEnded = true; this.emit('finish'); return this; }
    end() { this.writableEnded = true; this.emit('finish'); this.emit('close'); }
}

function makeChatResponse(overrides = {}) {
    return {
        id: 'chatcmpl-test123',
        object: 'chat.completion',
        created: 1741476542,
        model: 'gpt-4o',
        provider: 'openai',
        choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        ...overrides
    };
}

describe('OpenAI Compatibility', () => {
    describe('Non-streaming response structure', () => {
        it('returns valid choices array', () => {
            const response = makeChatResponse();
            expect(response.choices).to.be.an('array').with.length(1);
            expect(response.choices[0]).to.have.property('index', 0);
            expect(response.choices[0]).to.have.property('message');
            expect(response.choices[0].message).to.have.property('role', 'assistant');
            expect(response.choices[0].message).to.have.property('content', 'Hello!');
            expect(response.choices[0]).to.have.property('finish_reason', 'stop');
        });

        it('includes id, object, created, model, usage', () => {
            const response = makeChatResponse();
            expect(response).to.have.property('id');
            expect(response).to.have.property('object', 'chat.completion');
            expect(response).to.have.property('created');
            expect(response).to.have.property('model');
            expect(response).to.have.property('usage');
            expect(response.usage).to.have.property('prompt_tokens', 10);
            expect(response.usage).to.have.property('completion_tokens', 5);
            expect(response.usage).to.have.property('total_tokens', 15);
        });
    });

    describe('Response normalization', () => {
        it('adds refusal: null to message', () => {
            const response = makeChatResponse();
            const normalized = normalizeResponse(response);
            expect(normalized.choices[0].message).to.have.property('refusal', null);
        });

        it('adds function_call: null to message', () => {
            const response = makeChatResponse();
            const normalized = normalizeResponse(response);
            expect(normalized.choices[0].message).to.have.property('function_call', null);
        });

        it('adds system_fingerprint: null when absent', () => {
            const response = makeChatResponse();
            delete response.system_fingerprint;
            const normalized = normalizeResponse(response);
            expect(normalized).to.have.property('system_fingerprint', null);
        });

        it('preserves existing tool_calls', () => {
            const response = makeChatResponse({
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [{
                            id: 'call_abc',
                            type: 'function',
                            function: { name: 'bash', arguments: '{"command":"ls"}' }
                        }]
                    },
                    finish_reason: 'tool_calls'
                }]
            });
            const normalized = normalizeResponse(response);
            expect(normalized.choices[0].message.tool_calls).to.have.length(1);
            expect(normalized.choices[0].message.tool_calls[0].function.name).to.equal('bash');
        });

        it('normalizes streaming chunks', () => {
            const chunk = {
                id: 'chatcmpl-123',
                choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
                system_fingerprint: undefined
            };
            const normalized = normalizeStreamChunk(chunk);
            expect(normalized).to.have.property('system_fingerprint', null);
            expect(normalized.choices[0]).to.have.property('logprobs', null);
        });
    });

    describe('Error format', () => {
        it('returns { error: { message, type, code } } from server', async () => {
            const { createServer } = await import('../src/server.js');
            const config = await import('../src/config.js').then(m => m.loadConfig());
            const app = createServer(config);
            const request = (await import('supertest')).default;

            const res = await request(app)
                .post('/v1/chat/completions')
                .send({ model: 'nonexistent-model-xyz', messages: [] });

            expect(res.status).to.equal(404);
            expect(res.body).to.have.property('error');
            expect(res.body.error).to.have.property('message');
            expect(res.body.error).to.have.property('type');
            expect(res.body.error).to.have.property('code');
        });
    });

    describe('Tool calls in response', () => {
        it('normalizes response with tool_calls', () => {
            const response = makeChatResponse({
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [{
                            id: 'call_abc123',
                            type: 'function',
                            function: {
                                name: 'read_file',
                                arguments: '{"path":"/test.txt"}'
                            }
                        }]
                    },
                    finish_reason: 'tool_calls',
                    logprobs: null
                }]
            });
            const normalized = normalizeResponse(response);
            const msg = normalized.choices[0].message;
            expect(msg.tool_calls).to.have.length(1);
            expect(msg.tool_calls[0].id).to.equal('call_abc123');
            expect(msg.tool_calls[0].function.name).to.equal('read_file');
            expect(msg.content).to.equal(null);
            expect(msg).to.have.property('refusal', null);
            expect(msg).to.have.property('function_call', null);
        });
    });
});

describe('Responses API Format', () => {
    describe('chatCompletionsToResponse', () => {
        it('converts text response to Responses API format', () => {
            const chatResponse = makeChatResponse();
            const result = chatCompletionsToResponse(chatResponse, { model: 'gpt-4o' });

            expect(result).to.have.property('object', 'response');
            expect(result).to.have.property('status', 'completed');
            expect(result).to.have.property('model', 'gpt-4o');
            expect(result).to.have.property('output').that.is.an('array');
            expect(result).to.have.property('usage');
            expect(result.usage).to.have.property('input_tokens', 10);
            expect(result.usage).to.have.property('output_tokens', 5);
            expect(result.usage).to.have.property('total_tokens', 15);
            expect(result.usage).to.have.property('input_tokens_details');
            expect(result.usage).to.have.property('output_tokens_details');
        });

        it('wraps text content in message output item', () => {
            const chatResponse = makeChatResponse();
            const result = chatCompletionsToResponse(chatResponse);

            const msgItem = result.output.find(o => o.type === 'message');
            expect(msgItem).to.exist;
            expect(msgItem).to.have.property('role', 'assistant');
            expect(msgItem).to.have.property('status', 'completed');
            expect(msgItem.content).to.have.length(1);
            expect(msgItem.content[0]).to.have.property('type', 'output_text');
            expect(msgItem.content[0]).to.have.property('text', 'Hello!');
            expect(msgItem.content[0]).to.have.property('annotations').that.is.an('array');
        });

        it('converts tool_calls to function_call output items', () => {
            const chatResponse = makeChatResponse({
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [{
                            id: 'call_abc',
                            type: 'function',
                            function: { name: 'bash', arguments: '{"command":"ls"}' }
                        }]
                    },
                    finish_reason: 'tool_calls'
                }]
            });
            const result = chatCompletionsToResponse(chatResponse);

            const fcItem = result.output.find(o => o.type === 'function_call');
            expect(fcItem).to.exist;
            expect(fcItem).to.have.property('call_id', 'call_abc');
            expect(fcItem).to.have.property('name', 'bash');
            expect(fcItem).to.have.property('arguments', '{"command":"ls"}');
            expect(fcItem).to.have.property('status', 'completed');
        });

        it('handles combined text + tool_calls', () => {
            const chatResponse = makeChatResponse({
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'I will run that for you.',
                        tool_calls: [{
                            id: 'call_xyz',
                            type: 'function',
                            function: { name: 'bash', arguments: '{}' }
                        }]
                    },
                    finish_reason: 'tool_calls'
                }]
            });
            const result = chatCompletionsToResponse(chatResponse);

            const fcItem = result.output.find(o => o.type === 'function_call');
            const msgItem = result.output.find(o => o.type === 'message');
            expect(fcItem).to.exist;
            expect(msgItem).to.exist;
            expect(msgItem.content[0].text).to.equal('I will run that for you.');
        });

        it('preserves request metadata', () => {
            const chatResponse = makeChatResponse();
            const result = chatCompletionsToResponse(chatResponse, {
                model: 'gpt-4o',
                instructions: 'Be helpful',
                temperature: 0.5,
                previous_response_id: 'resp_prev123',
                tools: [{ type: 'function', function: { name: 'bash' } }],
                metadata: { session: 'abc' }
            });

            expect(result.instructions).to.equal('Be helpful');
            expect(result.temperature).to.equal(0.5);
            expect(result.previous_response_id).to.equal('resp_prev123');
            expect(result.tools).to.have.length(1);
            expect(result.metadata).to.deep.equal({ session: 'abc' });
        });
    });

    describe('Streaming event conversion', () => {
        it('emits response.created and response.in_progress first', () => {
            function *chunks() {
                yield { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] };
                yield { choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }] };
            }

            const events = [...convertStreamToResponseEvents(chunks(), { model: 'gpt-4o' })];
            expect(events[0].type).to.equal('response.created');
            expect(events[1].type).to.equal('response.in_progress');
            expect(events[0].response).to.have.property('object', 'response');
            expect(events[0].response).to.have.property('status', 'in_progress');
        });

        it('emits text delta events and final response.completed', () => {
            function *chunks() {
                yield { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] };
                yield { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] };
            }

            const events = [...convertStreamToResponseEvents(chunks(), { model: 'gpt-4o' })];
            const deltas = events.filter(e => e.type === 'response.output_text.delta');
            expect(deltas).to.have.length(2);
            expect(deltas[0].delta).to.equal('Hello');
            expect(deltas[1].delta).to.equal(' world');

            const completed = events.find(e => e.type === 'response.completed');
            expect(completed).to.exist;
            expect(completed.response).to.have.property('status', 'completed');
            expect(completed.response.output).to.be.an('array');
        });

        it('emits function_call events for tool calls', () => {
            function *chunks() {
                yield {
                    choices: [{
                        delta: {
                            tool_calls: [{
                                index: 0,
                                id: 'call_abc',
                                type: 'function',
                                function: { name: 'bash', arguments: '' }
                            }]
                        },
                        finish_reason: null
                    }]
                };
                yield {
                    choices: [{
                        delta: {
                            tool_calls: [{
                                index: 0,
                                function: { arguments: '{"command":"ls"}' }
                            }]
                        },
                        finish_reason: 'tool_calls'
                    }]
                };
            }

            const events = [...convertStreamToResponseEvents(chunks(), { model: 'gpt-4o' })];

            const argDeltas = events.filter(e => e.type === 'response.function_call_arguments.delta');
            expect(argDeltas).to.have.length(1);
            expect(argDeltas[0].delta).to.equal('{"command":"ls"}');

            const argDone = events.find(e => e.type === 'response.function_call_arguments.done');
            expect(argDone).to.exist;
            expect(argDone.arguments).to.equal('{"command":"ls"}');

            const completed = events.find(e => e.type === 'response.completed');
            const fcOutput = completed.response.output.find(o => o.type === 'function_call');
            expect(fcOutput).to.exist;
            expect(fcOutput.name).to.equal('bash');
            expect(fcOutput.arguments).to.equal('{"command":"ls"}');
        });

        it('includes sequence numbers', () => {
            function *chunks() {
                yield { choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] };
            }

            const events = [...convertStreamToResponseEvents(chunks())];
            for (let i = 1; i < events.length; i++) {
                expect(events[i].sequence_number).to.be.greaterThan(events[i - 1].sequence_number);
            }
        });

        it('handles usage from chunks', () => {
            function *chunks() {
                yield { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] };
                yield {
                    choices: [{ delta: {}, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
                };
            }

            const events = [...convertStreamToResponseEvents(chunks())];
            const completed = events.find(e => e.type === 'response.completed');
            expect(completed.response.usage.input_tokens).to.equal(50);
            expect(completed.response.usage.output_tokens).to.equal(10);
            expect(completed.response.usage.total_tokens).to.equal(60);
        });
    });
});

describe('Responses Route Handler', () => {
    it('returns Responses API format for non-streaming request', async () => {
        const router = {
            registry: { getThinkingConfig: () => ({ enabled: false }) },
            routeResponse: async () => ({
                id: 'resp_test123',
                object: 'response',
                status: 'completed',
                model: 'gpt-4o',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello!' }] }],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
            })
        };

        const handler = createResponsesHandler(router, null);
        const req = new EventEmitter();
        req.headers = {};
        req.body = { model: 'gpt-4o', input: 'Hello' };

        const res = new MockResponse();
        await handler(req, res, (err) => {});

        expect(res.statusCode).to.equal(200);
        expect(res.payload.object).to.equal('response');
        expect(res.payload.output).to.be.an('array');
    });

    it('streams Responses API events for streaming request', async () => {
        function *eventGen() {
            yield { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' }, sequence_number: 0 };
            yield { type: 'response.output_text.delta', delta: 'Hi', sequence_number: 1 };
            yield { type: 'response.completed', response: { id: 'resp_test', status: 'completed' }, sequence_number: 2 };
        }

        const router = {
            registry: { getThinkingConfig: () => ({ enabled: false }) },
            routeResponse: async () => ({
                stream: true,
                generator: eventGen(),
                _format: 'responses'
            })
        };

        const handler = createResponsesHandler(router, null);
        const req = new EventEmitter();
        req.headers = {};
        req.body = { model: 'gpt-4o', input: 'Hello', stream: true };

        const res = new MockResponse();
        const handlerPromise = handler(req, res, (err) => {});

        await new Promise(resolve => setTimeout(resolve, 100));
        await handlerPromise;

        expect(res.body).to.include('response.created');
        expect(res.body).to.include('response.output_text.delta');
        expect(res.body).to.include('response.completed');
        expect(res.body).to.include('[DONE]');
    });
});

describe('_buildChatOptions parameter forwarding', () => {
    let router;

    before(async () => {
        const { ModelRouter } = await import('../src/core/model-router.js');
        const { loadConfig } = await import('../src/config.js');
        const config = await loadConfig();
        router = new ModelRouter(config);
    });

    it('forwards frequency_penalty and presence_penalty', () => {
        const opts = router._buildChatOptions(
            { messages: [], frequency_penalty: 1.5, presence_penalty: 0.8 },
            { extraBody: {} }
        );
        expect(opts.frequency_penalty).to.equal(1.5);
        expect(opts.presence_penalty).to.equal(0.8);
    });

    it('forwards seed, top_p, logit_bias, user, n', () => {
        const opts = router._buildChatOptions(
            { messages: [], seed: 42, top_p: 0.9, logit_bias: { '123': -100 }, user: 'user-1', n: 3 },
            { extraBody: {} }
        );
        expect(opts.seed).to.equal(42);
        expect(opts.top_p).to.equal(0.9);
        expect(opts.logit_bias).to.deep.equal({ '123': -100 });
        expect(opts.user).to.equal('user-1');
        expect(opts.n).to.equal(3);
    });

    it('forwards tools, tool_choice, parallel_tool_calls', () => {
        const tools = [{ type: 'function', function: { name: 'bash' } }];
        const opts = router._buildChatOptions(
            { messages: [], tools, tool_choice: 'auto', parallel_tool_calls: false },
            { extraBody: {} }
        );
        expect(opts.tools).to.equal(tools);
        expect(opts.tool_choice).to.equal('auto');
        expect(opts.parallel_tool_calls).to.equal(false);
    });

    it('forwards response_format and stream_options', () => {
        const rf = { type: 'json_object' };
        const so = { include_usage: true };
        const opts = router._buildChatOptions(
            { messages: [], response_format: rf, stream_options: so },
            { extraBody: {} }
        );
        expect(opts.response_format).to.equal(rf);
        expect(opts.stream_options).to.equal(so);
    });

    it('forwards functions and function_call (legacy)', () => {
        const fns = [{ name: 'get_weather', parameters: {} }];
        const opts = router._buildChatOptions(
            { messages: [], functions: fns, function_call: 'auto' },
            { extraBody: {} }
        );
        expect(opts.functions).to.equal(fns);
        expect(opts.function_call).to.equal('auto');
    });

    it('resolves max_completion_tokens with precedence over max_tokens', () => {
        const opts = router._buildChatOptions(
            { messages: [], max_completion_tokens: 2048, max_tokens: 1024 },
            { extraBody: {} }
        );
        expect(opts.maxTokens).to.equal(2048);
        expect(opts.maxCompletionTokens).to.equal(2048);
    });

    it('uses max_tokens when max_completion_tokens absent', () => {
        const opts = router._buildChatOptions(
            { messages: [], max_tokens: 1024 },
            { extraBody: {} }
        );
        expect(opts.maxTokens).to.equal(1024);
        expect(opts.maxCompletionTokens).to.equal(undefined);
    });

    it('forwards stop sequences', () => {
        const opts = router._buildChatOptions(
            { messages: [], stop: ['\n', 'END'] },
            { extraBody: {} }
        );
        expect(opts.stop).to.deep.equal(['\n', 'END']);
    });

    it('forwards logprobs and top_logprobs', () => {
        const opts = router._buildChatOptions(
            { messages: [], logprobs: true, top_logprobs: 5 },
            { extraBody: {} }
        );
        expect(opts.logprobs).to.equal(true);
        expect(opts.top_logprobs).to.equal(5);
    });
});
