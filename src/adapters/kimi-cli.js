/**
 * Kimi CLI Adapter - Protocol handler for Kimi CLI.
 *
 * Supports session-aware mode via --session flag: the CLI maintains conversation
 * history in ~/.kimi/sessions/, keyed by the session ID we provide.
 * Without a sessionId, each request runs in isolation (stateless).
 */

import { spawn } from 'child_process';

export function createKimiCliAdapter() {
    /**
     * Build CLI args, optionally including --session for resume/create.
     * @param {string|null} sessionId
     * @returns {string[]}
     */
    function buildCliArgs(sessionId) {
        const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json'];
        if (sessionId) {
            args.push('--session', sessionId);
        }
        return args;
    }

    /**
     * Run the CLI and return the full response text.
     * @param {string[]} args
     * @param {object} message  { role: 'user', content: string }
     * @param {number} timeout
     * @returns {Promise<string>}
     */
    function runCli(args, message, timeout) {
        return new Promise((resolve, reject) => {
            const child = spawn('kimi', args, {
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
                shell: false
            });

            const stdout = [];
            const stderr = [];

            child.stdout.on('data', chunk => stdout.push(chunk));
            child.stderr.on('data', chunk => {
                if (process.env.DEBUG_KIMI_CLI === '1') {
                    console.error('[kimi-cli][stderr]', chunk.toString('utf-8'));
                }
                stderr.push(chunk);
            });

            child.on('close', code => {
                const output = Buffer.concat(stdout).toString('utf-8').trim();
                const errors = Buffer.concat(stderr).toString('utf-8').trim();

                const lines = output.split('\n').filter(l => l.trim());
                let lastAssistantContent = '';

                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.role === 'assistant' && msg.content) {
                            if (Array.isArray(msg.content)) {
                                let text = '';
                                for (const block of msg.content) {
                                    if (block.type === 'think' && block.think) {
                                        text += `<think>\n${block.think}\n
</think>

\n`;
                                    } else if (block.type === 'text' && block.text) {
                                        text += block.text;
                                    }
                                }
                                lastAssistantContent = text;
                            } else {
                                lastAssistantContent = msg.content;
                            }
                        }
                    } catch {
                        // Skip invalid JSON lines
                    }
                }

                // Fallback: if JSON parse failed, try raw output
                if (!lastAssistantContent && output) {
                    try {
                        const parsedAll = JSON.parse(output);
                        if (parsedAll.role === 'assistant' && parsedAll.content) {
                            lastAssistantContent = parsedAll.content;
                        }
                    } catch {
                        const contentMatch = output.match(/"content"\s*:\s*"([\s\S]*?)"\s*\}/);
                        if (contentMatch) {
                            try {
                                lastAssistantContent = JSON.parse(`{"c": "${contentMatch[1]}"}`).c;
                            } catch {
                                // Leave empty
                            }
                        } else {
                            const partialMatch = output.match(/"content"\s*:\s*"([\s\S]*)/);
                            if (partialMatch) {
                                lastAssistantContent = partialMatch[1]
                                    .replace(/\\n/g, '\n')
                                    .replace(/\\"/g, '"')
                                    .replace(/\\\\/g, '\\')
                                    .replace(/\}$/, '')
                                    .replace(/"$/, '');
                            }
                        }
                    }
                }

                if (code !== 0 && !lastAssistantContent) {
                    reject(new Error(`Kimi CLI exited ${code}: ${errors || output.slice(-200)}`));
                    return;
                }

                resolve(lastAssistantContent || output);
            });

            child.on('error', err => {
                reject(new Error(`Failed to spawn Kimi CLI: ${err.message}. Is 'kimi' installed and in PATH?`));
            });

            const input = JSON.stringify(message) + '\n\n';
            child.stdin.write(input, err => {
                if (err) {
                    reject(err);
                }
            });
            child.stdin.end();

            // Timeout guard
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`Kimi CLI timed out after ${timeout}ms`));
            }, timeout);
            child.on('close', () => clearTimeout(timer));
        });
    }

    /**
     * Extract assistant content from stream-json output lines.
     * @param {string} output
     * @returns {string|null}
     */
    function extractContentFromStreamJson(output) {
        const lines = output.split('\n').filter(l => l.trim());
        let lastAssistantContent = '';

        for (const line of lines) {
            try {
                const msg = JSON.parse(line);
                if (msg.role === 'assistant' && msg.content) {
                    if (Array.isArray(msg.content)) {
                        let text = '';
                        for (const block of msg.content) {
                            if (block.type === 'think' && block.think) {
                                text += `<think>\n${block.think}\n
</think>

\n`;
                            } else if (block.type === 'text' && block.text) {
                                text += block.text;
                            }
                        }
                        lastAssistantContent = text;
                    } else {
                        lastAssistantContent = msg.content;
                    }
                }
            } catch {
                // Skip invalid JSON
            }
        }

        return lastAssistantContent || null;
    }

    /**
     * Extract JSON from content that may have markdown code fences.
     * @param {string} content
     * @returns {string}
     */
    function extractJson(content) {
        const jsonBlockMatch = content.match(/```json\s*\n?([\s\S]*?)```/);
        if (jsonBlockMatch) return jsonBlockMatch[1].trim();

        const codeBlockMatch = content.match(/```\s*\n?([\s\S]*?)```/);
        if (codeBlockMatch) {
            try {
                JSON.parse(codeBlockMatch[1].trim());
                return codeBlockMatch[1].trim();
            } catch {
                // Not valid JSON
            }
        }

        const jsonMatch = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
        if (jsonMatch) {
            try {
                JSON.parse(jsonMatch[1]);
                return jsonMatch[1];
            } catch {
                // Not valid JSON
            }
        }

        return content;
    }

    return {
        name: 'kimi-cli',

        /**
         * Chat completion.
         * Sends only the latest message to the CLI. If sessionId is provided, the CLI
         * uses it to resume/create the conversation in ~/.kimi/sessions/.
         * Without sessionId, the CLI runs in stateless mode.
         */
        async chatComplete(modelConfig, request) {
            const { adapterModel, timeout, capabilities } = modelConfig;
            const model = adapterModel || 'kimi-k2.5';
            const cliTimeout = timeout || 120000;
            const maxOutputTokens = capabilities?.maxOutputTokens || 4096;

            if (request.maxTokens && request.maxTokens > maxOutputTokens) {
                console.warn(`[kimi-cli] Warning: Requested max_tokens (${request.maxTokens}) exceeds CLI fixed limit (~${maxOutputTokens}). Output may be truncated.`);
            }

            const sessionId = request.sessionId || null;
            const args = buildCliArgs(sessionId);

            // Session-aware: extract the last user message from the array.
            // The model-router compacts messages before sending, so last user msg is the latest.
            // Non-session: use request.prompt (already squashed by buildMessages in router).
            const messageContent = sessionId
                ? (() => {
                    const msgs = request.messages || [];
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        if (msgs[i].role === 'user') return msgs[i].content || '';
                    }
                    return '';
                })()
                : (request.prompt || '');

            const content = await runCli(args, { role: 'user', content: messageContent }, cliTimeout);
            const finalContent = request.schema ? extractJson(content) : content;

            return {
                id: `kimi-cli-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                provider: 'kimi',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: finalContent },
                    finish_reason: 'stop'
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            };
        },

        /**
         * Streaming chat completion.
         * Yields the full response as a single chunk when sessionId is provided.
         * Streams incremental deltas in stateless mode.
         */
        async *streamComplete(modelConfig, request) {
            const { adapterModel, timeout, capabilities } = modelConfig;
            const model = adapterModel || 'kimi-k2.5';
            const cliTimeout = timeout || 120000;
            const maxOutputTokens = capabilities?.maxOutputTokens || 4096;
            const sessionId = request.sessionId || null;

            if (request.maxTokens && request.maxTokens > maxOutputTokens) {
                console.warn(`[kimi-cli] Warning: Requested max_tokens (${request.maxTokens}) exceeds CLI fixed limit (~${maxOutputTokens}). Output may be truncated.`);
            }

            const streamId = `kimi-cli-${Date.now()}`;

            if (sessionId) {
                // Session-aware: extract latest user message from array
                const msgs = request.messages || [];
                let messageContent = '';
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].role === 'user') {
                        messageContent = msgs[i].content || '';
                        break;
                    }
                }
                const message = { role: 'user', content: messageContent };
                // Session-aware: CLI manages conversation. Yield full response as one chunk.
                const args = buildCliArgs(sessionId);
                const content = await runCli(args, message, cliTimeout);
                const finalContent = request.schema ? extractJson(content) : content;

                yield {
                    id: streamId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: { content: finalContent } }]
                };
            } else {
                // Stateless: spawn fresh CLI, stream deltas
                const args = [...buildCliArgs(null), '--final-message-only'];
                const child = spawn('kimi', args, {
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
                    shell: false
                });

                let lastContent = '';

                try {
                    const input = JSON.stringify({ role: 'user', content: request.prompt || '' }) + '\n\n';
                    child.stdin.write(input);
                    child.stdin.end();

                    for await (const chunk of child.stdout) {
                        const text = chunk.toString('utf-8');
                        if (process.env.DEBUG_KIMI_CLI === '1') {
                            console.error('[kimi-cli][stdout]', text);
                        }

                        const lines = text.split('\n');
                        for (const rawLine of lines) {
                            const line = rawLine.trim();
                            if (!line) continue;
                            try {
                                const msg = JSON.parse(line);
                                let newContent = '';

                                if (msg.role === 'assistant' && msg.content) {
                                    if (Array.isArray(msg.content)) {
                                        for (const block of msg.content) {
                                            if (block.type === 'think' && block.think) {
                                                newContent += `<think>\n${block.think}\n
</think>

\n`;
                                            } else if (block.type === 'text' && block.text) {
                                                newContent += block.text;
                                            }
                                        }
                                    } else {
                                        newContent = msg.content;
                                    }

                                    if (newContent.startsWith(lastContent)) {
                                        const diff = newContent.slice(lastContent.length);
                                        if (diff) {
                                            yield {
                                                id: streamId,
                                                object: 'chat.completion.chunk',
                                                created: Math.floor(Date.now() / 1000),
                                                model,
                                                choices: [{ index: 0, delta: { content: diff } }]
                                            };
                                        }
                                    } else {
                                        yield {
                                            id: streamId,
                                            object: 'chat.completion.chunk',
                                            created: Math.floor(Date.now() / 1000),
                                            model,
                                            choices: [{ index: 0, delta: { content: newContent } }]
                                        };
                                    }
                                    lastContent = newContent;
                                }
                            } catch {
                                // Skip invalid JSON
                            }
                        }
                    }
                } finally {
                    if (!child.killed) child.kill();
                }
            }

            yield {
                id: streamId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            };
        },

        /**
         * Create embeddings - not supported.
         */
        async createEmbedding(modelConfig, request) {
            throw new Error('[KimiCliAdapter] Embeddings not supported');
        },

        /**
         * Generate image - not supported.
         */
        async generateImage(modelConfig, request) {
            throw new Error('[KimiCliAdapter] Image generation not supported');
        },

        /**
         * Synthesize speech - not supported.
         */
        async synthesizeSpeech(modelConfig, request) {
            throw new Error('[KimiCliAdapter] TTS not supported');
        },

        /**
         * Generate video - not supported.
         */
        async generateVideo(modelConfig, request) {
            throw new Error('[KimiCliAdapter] Video generation not supported');
        },

        /**
         * List available models.
         */
        async listModels(modelConfig) {
            const { adapterModel, capabilities } = modelConfig;
            const model = adapterModel || 'kimi-k2.5';
            const contextWindow = capabilities?.contextWindow || 256000;
            const maxOutputTokens = capabilities?.maxOutputTokens || 4096;

            return [{
                id: model,
                object: 'model',
                owned_by: 'kimi',
                capabilities: {
                    chat: true,
                    embeddings: false,
                    structuredOutput: false,
                    streaming: false,
                    vision: false,
                    context_window: contextWindow,
                    max_output_tokens: maxOutputTokens
                }
            }];
        }
    };
}
