/**
 * Kimi CLI Adapter - Protocol handler for Kimi CLI.
 * Stateless - model config passed per-request.
 */

import { spawn } from 'child_process';
import { request as httpRequest } from '../utils/http.js';

export function createKimiCliAdapter() {
    return {
        name: 'kimi-cli',

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            const { adapterModel, timeout } = modelConfig;
            const model = adapterModel || 'kimi-k2.5';
            const cliTimeout = timeout || 120000;

            const messages = buildMessages(request.systemPrompt, request.messages, request.prompt, request.schema);
            const output = await runKimiCli(messages, request.schema, cliTimeout);

            let content = output;
            if (request.schema) {
                content = extractJson(output);
            }

            return {
                id: `kimi-cli-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                provider: 'kimi',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: 'stop'
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            };
        },

        /**
         * Streaming chat completion.
         */
        async *streamComplete(modelConfig, request) {
            const { adapterModel, timeout } = modelConfig;
            const model = adapterModel || 'kimi-k2.5';
            const cliTimeout = timeout || 120000;

            const messages = buildMessages(request.systemPrompt, request.messages, request.prompt, request.schema);

            // We use the same runKimiCli stream approach, but intercept the stdout
            const inputLines = messages.map(m => JSON.stringify(m)).join('\n') + '\n\n';

            const args = [
                '--print',
                '--input-format', 'stream-json',
                '--output-format', 'stream-json'
                // Removed --final-message-only so it might stream progressively
            ];

            const child = spawn('kimi', args, {
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
                timeout: cliTimeout,
                shell: false
            });

            console.log('[kimi-cli] Spawned process with args:', args.join(' '));

            child.stdin.write(inputLines);
            child.stdin.end();

            const streamId = `kimi-cli-${Date.now()}`;
            let lastContent = '';
            
            // Read stream chunk by chunk manually
            try {
                let buffer = '';
                
                // Wrap stream in iterator to properly yield chunks
                for await (const chunk of child.stdout) {
                    buffer += chunk.toString('utf-8');
                    
                    if (process.env.DEBUG_KIMI_CLI === '1') {
                         console.log('[kimi-cli][stdout]', chunk.toString('utf-8'));
                    }

                    // Process all complete lines in the buffer
                    let newlineIndex;
                    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.substring(0, newlineIndex).trim();
                        buffer = buffer.substring(newlineIndex + 1);
                        
                        if (!line) continue;

                        try {
                            const msg = JSON.parse(line);
                            
                            // If Kimi emits tool operations inside the stream, we can log them but we shouldn't fail
                            if (msg.role === 'tool' || msg.role === 'user') {
                                continue; 
                            }
                            
                            if (msg.role === 'assistant' && msg.content) {
                                let newContent = '';
                                
                                // Handling when 'content' is an array of objects
                                if (Array.isArray(msg.content)) {
                                    for (const block of msg.content) {
                                        if (block.type === 'think' && block.think) {
                                            newContent += `<think>\n${block.think}\n</think>\n`;
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
                        } catch (e) {
                            // incomplete or invalid JSON on this line
                        }
                    }
                }
            } finally {
                if (!child.killed) {
                    child.kill();
                }
            }

            // Yield stop
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
                    context_window: contextWindow
                }
            }];
        }
    };
}

async function runKimiCli(messages, isJsonMode, timeout) {
    // Add two newlines to ensure stream-json parser hits an empty line and/or EOF properly
    const inputLines = messages.map(m => JSON.stringify(m)).join('\n') + '\n\n';

    if (process.env.DEBUG_KIMI_CLI === '1') {
        console.error(`[kimi-cli] Messages count: ${messages.length}`);
        console.error(`[kimi-cli] Input: ${inputLines.slice(0, 500)}...`);
    }

    return new Promise((resolve, reject) => {
        const stdout = [];
        const stderr = [];

        const args = [
            '--print',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--final-message-only'
        ];

        const child = spawn('kimi', args, {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            timeout,
            shell: false
        });

        child.stdin.write(inputLines);
        child.stdin.end();

        child.stdout.on('data', data => stdout.push(data));
        child.stderr.on('data', data => stderr.push(data));

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
                                    text += `<think>\n${block.think}\n</think>\n`;
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

            // Fallback: if JSON parse failed (e.g. multi-line output or crash truncation)
            if (!lastAssistantContent && output) {
                try {
                    const parsedAll = JSON.parse(output);
                    if (parsedAll.role === 'assistant' && parsedAll.content) {
                        lastAssistantContent = parsedAll.content;
                    }
                } catch {
                    // Try to regex extract content
                    const contentMatch = output.match(/"content"\s*:\s*"([\s\S]*?)"\s*\}/);
                    if (contentMatch) {
                        try {
                            lastAssistantContent = JSON.parse(`{"c": "${contentMatch[1]}"}`).c;
                        } catch {
                            // Leave it empty
                        }
                    } else {
                        // Last resort for brutally truncated JSON string
                        const partialMatch = output.match(/"content"\s*:\s*"([\s\S]*)/);
                        if (partialMatch) {
                            // It's truncated, so unescape as much as we can safely
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
    });
}

function buildMessages(systemPrompt, messages, prompt, schema) {
    const msgs = [];

    if (systemPrompt) {
        msgs.push({ role: 'system', content: systemPrompt });
    }

    // Squash chat history into a single user prompt because the Kimi CLI
    // treats every incoming stdin {"role":"user"} message as an execution trigger!
    let squashedContent = '';

    if (messages && Array.isArray(messages)) {
        const historyMessages = messages.filter(m => m.role !== 'system' && m.content !== prompt);
        
        if (historyMessages.length > 0) {
            squashedContent += '=== PREVIOUS CONVERSATION HISTORY ===\n';
            for (const msg of historyMessages) {
                const roleCapitalized = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
                squashedContent += `${roleCapitalized}: ${msg.content}\n\n`;
            }
            squashedContent += '=== CURRENT PROMPT ===\n';
        }
    }

    if (prompt) {
        squashedContent += prompt;
    }

    if (squashedContent) {
        if (schema) {
            squashedContent += '\n\nRespond with valid JSON only.';
        }
        msgs.push({ role: 'user', content: squashedContent.trim() });
    }

    return msgs;
}

function extractJson(content) {
    // Try ```json block first
    const jsonBlockMatch = content.match(/```json\s*\n?([\s\S]*?)```/);
    if (jsonBlockMatch) return jsonBlockMatch[1].trim();

    // Try any ``` block
    const codeBlockMatch = content.match(/```\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
        try {
            JSON.parse(codeBlockMatch[1].trim());
            return codeBlockMatch[1].trim();
        } catch {
            // Not valid JSON
        }
    }

    // Try to find JSON object/array
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
