import { expect } from 'chai';
import { stripThinking, createThinkingStripper } from '../src/utils/format.js';
import { Router } from '../src/core/router.js';
import { loadConfig } from '../src/config.js';

describe('stripThinking functionality', function() {
    
    describe('Utility functions', () => {
        it('should strip <think> tags and content', () => {
            const input = 'Hello <think>some reasoning here</think> world';
            const result = stripThinking(input);
            expect(result).to.not.include('reasoning');
            expect(result).to.include('Hello');
            expect(result).to.include('world');
        });

        it('should strip <analysis> tags and content', () => {
            const input = 'Start <analysis>deep analysis content</analysis> end';
            const result = stripThinking(input);
            expect(result).to.not.include('analysis');
            expect(result).to.include('Start');
            expect(result).to.include('end');
        });

        it('should strip <reasoning> tags and content', () => {
            const input = 'Before <reasoning>step by step reasoning</reasoning> after';
            const result = stripThinking(input);
            expect(result).to.not.include('step by step');
            expect(result).to.include('Before');
            expect(result).to.include('after');
        });

        it('should handle multiple thinking tags in one text', () => {
            const input = 'Start <think>reasoning 1</think> middle <analysis>reasoning 2</analysis> end';
            const result = stripThinking(input);
            expect(result).to.not.include('reasoning 1');
            expect(result).to.not.include('reasoning 2');
            expect(result).to.include('Start');
            expect(result).to.include('middle');
            expect(result).to.include('end');
        });

        it('should handle nested-looking tags (not actually nested)', () => {
            const input = 'Hello <think>some <analysis>mixed</analysis> content</think> world';
            const result = stripThinking(input);
            expect(result).to.not.include('mixed');
            expect(result).to.include('Hello');
            expect(result).to.include('world');
        });

        it('should handle orphan close tags (treats preceding as thinking)', () => {
            const input = 'this is thinking</think> actual content';
            const result = stripThinking(input);
            expect(result).to.not.include('this is thinking');
            expect(result).to.include('actual content');
        });

        it('should handle empty thinking tags', () => {
            const input = 'Hello <think></think> world';
            const result = stripThinking(input);
            // Empty tags result in double spaces (spaces around the removed tag)
            expect(result).to.include('Hello');
            expect(result).to.include('world');
            expect(result).to.not.include('<think>');
            expect(result.replace(/\s+/g, ' ').trim()).to.equal('Hello world');
        });

        it('should return original text when no thinking tags', () => {
            const input = 'Just normal content without any tags';
            const result = stripThinking(input);
            expect(result).to.equal(input);
        });

        it('should handle null input', () => {
            const result = stripThinking(null);
            expect(result).to.be.null;
        });

        it('should handle undefined input', () => {
            const result = stripThinking(undefined);
            expect(result).to.be.undefined;
        });

        it('should handle empty string', () => {
            const result = stripThinking('');
            expect(result).to.equal('');
        });

        it('should handle custom tags', () => {
            const input = 'Hello <custom>secret</custom> world';
            const result = stripThinking(input, ['custom']);
            expect(result).to.not.include('secret');
            expect(result).to.include('Hello');
            expect(result).to.include('world');
        });
    });

    describe('Streaming stripThinking', () => {
        it('should strip thinking content across chunks', () => {
            const stripper = createThinkingStripper();
            let output = '';
            
            output += stripper.process('Hello <think>');
            output += stripper.process('internal reasoning');
            output += stripper.process('</think> world');
            output += stripper.flush();
            
            expect(output).to.not.include('internal');
            expect(output).to.not.include('reasoning');
            expect(output).to.include('Hello');
            expect(output).to.include('world');
        });

        it('should handle chunks split in middle of tags', () => {
            const stripper = createThinkingStripper();
            let output = '';
            
            output += stripper.process('Hello <thi');
            output += stripper.process('nk>secret</th');
            output += stripper.process('ink> world');
            output += stripper.flush();
            
            expect(output).to.not.include('secret');
            expect(output).to.include('Hello');
            expect(output).to.include('world');
        });

        it('should handle multiple thinking blocks in streaming', () => {
            const stripper = createThinkingStripper();
            let output = '';
            
            output += stripper.process('Start <think>');
            output += stripper.process('first reasoning');
            output += stripper.process('</think> middle <analysis>');
            output += stripper.process('second analysis');
            output += stripper.process('</analysis> end');
            output += stripper.flush();
            
            expect(output).to.not.include('first reasoning');
            expect(output).to.not.include('second analysis');
            expect(output).to.include('Start');
            expect(output).to.include('middle');
            expect(output).to.include('end');
        });

        it('should accumulate content when not in thinking block', () => {
            const stripper = createThinkingStripper();
            let output = '';
            
            output += stripper.process('First ');
            output += stripper.process('second ');
            output += stripper.process('third');
            output += stripper.flush();
            
            expect(output.trim()).to.equal('First second third');
        });

        it('should support config object with custom tags', () => {
            const stripper = createThinkingStripper({ tags: ['custom', 'secret'] });
            let output = '';
            
            output += stripper.process('Hello <custom>hidden</custom> world');
            output += stripper.flush();
            
            expect(output).to.not.include('hidden');
            expect(output).to.include('Hello');
            expect(output).to.include('world');
        });

        it('should support orphanCloseAsSeparator: false', () => {
            // When orphanCloseAsSeparator is false, orphan close tags should be treated as literal text
            const config = { tags: ['think'], orphanCloseAsSeparator: false };
            const result = stripThinking('content before</think> content after', config);
            
            // Should NOT strip content before orphan close tag
            expect(result).to.include('content before');
            expect(result).to.include('content after');
        });

        it('should support orphanCloseAsSeparator: true (default)', () => {
            const result = stripThinking('content before</think> content after');
            
            // Should strip content before orphan close tag
            expect(result).to.not.include('content before');
            expect(result).to.include('content after');
        });

        it('should strip new default tags: <thinking>, <thought>, <thoughts>', () => {
            const input = 'A <thinking>B</thinking> C <thought>D</thought> E <thoughts>F</thoughts> G';
            const result = stripThinking(input);
            
            expect(result).to.include('A');
            expect(result).to.not.include('B');
            expect(result).to.include('C');
            expect(result).to.not.include('D');
            expect(result).to.include('E');
            expect(result).to.not.include('F');
            expect(result).to.include('G');
        });

        it('should strip chain_of_thought and cot tags', () => {
            const input = 'Start <chain_of_thought>step 1, step 2</chain_of_thought> end';
            const result = stripThinking(input);
            
            expect(result).to.not.include('step 1');
            expect(result).to.include('Start');
            expect(result).to.include('end');
        });
    });

    describe('Router integration', () => {
        let config;
        
        before(async () => {
            config = await loadConfig();
        });

        it('should strip thinking content in non-streaming response when configured', async () => {
            const testConfig = {
                ...config,
                providers: {
                    ...config.providers,
                    testprovider: {
                        type: 'lmstudio',
                        endpoint: 'http://localhost:1234',
                        model: 'test-model',
                        stripThinking: true,
                        capabilities: {
                            embeddings: true,
                            structuredOutput: true,
                            streaming: true
                        }
                    }
                },
                routing: {
                    defaultProvider: 'testprovider'
                },
                compaction: { enabled: false }
            };

            const router = new Router(testConfig);
            const adapter = router.adapters.get('testprovider');
            
            // Mock predict to return content with thinking tags
            adapter.predict = async () => ({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: 'Hello <think>internal reasoning</think> world'
                    }
                }]
            });

            const result = await router.route({
                model: 'test-model',
                messages: [{ role: 'user', content: 'Hi' }]
            });

            expect(result.choices[0].message.content).to.not.include('internal reasoning');
            expect(result.choices[0].message.content).to.include('Hello');
            expect(result.choices[0].message.content).to.include('world');
        });

        it('should NOT strip thinking content when stripThinking is false', async () => {
            const testConfig = {
                ...config,
                providers: {
                    ...config.providers,
                    testprovider: {
                        type: 'lmstudio',
                        endpoint: 'http://localhost:1234',
                        model: 'test-model',
                        stripThinking: false,
                        capabilities: {
                            embeddings: true,
                            structuredOutput: true,
                            streaming: true
                        }
                    }
                },
                routing: {
                    defaultProvider: 'testprovider'
                },
                compaction: { enabled: false }
            };

            const router = new Router(testConfig);
            const adapter = router.adapters.get('testprovider');
            
            adapter.predict = async () => ({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: 'Hello <think>internal reasoning</think> world'
                    }
                }]
            });

            const result = await router.route({
                model: 'test-model',
                messages: [{ role: 'user', content: 'Hi' }]
            });

            expect(result.choices[0].message.content).to.include('<think>');
            expect(result.choices[0].message.content).to.include('internal reasoning');
        });

        it('should NOT strip thinking content when stripThinking is not set (default)', async () => {
            const testConfig = {
                ...config,
                providers: {
                    ...config.providers,
                    testprovider: {
                        type: 'lmstudio',
                        endpoint: 'http://localhost:1234',
                        model: 'test-model',
                        // stripThinking not set
                        capabilities: {
                            embeddings: true,
                            structuredOutput: true,
                            streaming: true
                        }
                    }
                },
                routing: {
                    defaultProvider: 'testprovider'
                },
                compaction: { enabled: false }
            };

            const router = new Router(testConfig);
            const adapter = router.adapters.get('testprovider');
            
            adapter.predict = async () => ({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: 'Hello <think>internal reasoning</think> world'
                    }
                }]
            });

            const result = await router.route({
                model: 'test-model',
                messages: [{ role: 'user', content: 'Hi' }]
            });

            expect(result.choices[0].message.content).to.include('<think>');
            expect(result.choices[0].message.content).to.include('internal reasoning');
        });

        it('should return stripThinking flag in streaming response when configured', async () => {
            const testConfig = {
                ...config,
                providers: {
                    ...config.providers,
                    testprovider: {
                        type: 'lmstudio',
                        endpoint: 'http://localhost:1234',
                        model: 'test-model',
                        stripThinking: true,
                        capabilities: {
                            embeddings: true,
                            structuredOutput: true,
                            streaming: true
                        }
                    }
                },
                routing: {
                    defaultProvider: 'testprovider'
                },
                compaction: { enabled: false }
            };

            const router = new Router(testConfig);
            const adapter = router.adapters.get('testprovider');
            
            // Mock streamComplete
            adapter.streamComplete = async function* () {
                yield {
                    choices: [{ delta: { content: 'Hello <think>' }, index: 0 }]
                };
                yield {
                    choices: [{ delta: { content: 'reasoning</think> world' }, index: 0 }]
                };
            };

            const result = await router.route({
                model: 'test-model',
                messages: [{ role: 'user', content: 'Hi' }],
                stream: true
            });

            expect(result.stream).to.be.true;
            expect(result.stripThinking).to.be.true;
        });

        it('should support stripThinking as config object with custom tags', async () => {
            const testConfig = {
                ...config,
                providers: {
                    ...config.providers,
                    testprovider: {
                        type: 'lmstudio',
                        endpoint: 'http://localhost:1234',
                        model: 'test-model',
                        stripThinking: {
                            enabled: true,
                            tags: ['custom_thinking', 'secret'],
                            orphanCloseAsSeparator: true
                        },
                        capabilities: {
                            embeddings: true,
                            structuredOutput: true,
                            streaming: true
                        }
                    }
                },
                routing: {
                    defaultProvider: 'testprovider'
                },
                compaction: { enabled: false }
            };

            const router = new Router(testConfig);
            const adapter = router.adapters.get('testprovider');
            
            adapter.predict = async () => ({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: 'Hello <custom_thinking>internal</custom_thinking> <secret>hidden</secret> world'
                    }
                }]
            });

            const result = await router.route({
                model: 'test-model',
                messages: [{ role: 'user', content: 'Hi' }]
            });

            // Should strip custom tags
            expect(result.choices[0].message.content).to.not.include('internal');
            expect(result.choices[0].message.content).to.not.include('hidden');
            expect(result.choices[0].message.content).to.include('Hello');
            expect(result.choices[0].message.content).to.include('world');
        });

        it('should support enabled: false in config object to disable stripping', async () => {
            const testConfig = {
                ...config,
                providers: {
                    ...config.providers,
                    testprovider: {
                        type: 'lmstudio',
                        endpoint: 'http://localhost:1234',
                        model: 'test-model',
                        stripThinking: {
                            enabled: false,
                            tags: ['think']
                        },
                        capabilities: {
                            embeddings: true,
                            structuredOutput: true,
                            streaming: true
                        }
                    }
                },
                routing: {
                    defaultProvider: 'testprovider'
                },
                compaction: { enabled: false }
            };

            const router = new Router(testConfig);
            const adapter = router.adapters.get('testprovider');
            
            adapter.predict = async () => ({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: 'Hello <think>internal reasoning</think> world'
                    }
                }]
            });

            const result = await router.route({
                model: 'test-model',
                messages: [{ role: 'user', content: 'Hi' }]
            });

            // Should NOT strip because enabled is false
            expect(result.choices[0].message.content).to.include('internal reasoning');
        });
    });
});
