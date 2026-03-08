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
            const result = await this.chatComplete(modelConfig, request);

            yield {
                id: result.id,
                object: 'chat.completion.chunk',
                created: result.created,
                model: result.model,
                choices: [{
                    index: 0,
                    delta: { content: result.choices[0].message.content },
                    finish_reason: 'stop'
                }]
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
    const inputLines = messages.map(m => JSON.stringify(m)).join('\n');

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

            if (code !== 0) {
                reject(new Error(`Kimi CLI exited ${code}: ${errors || output}`));
                return;
            }

            const lines = output.split('\n').filter(l => l.trim());
            let lastAssistantContent = '';

            for (const line of lines) {
                try {
                    const msg = JSON.parse(line);
                    if (msg.role === 'assistant' && msg.content) {
                        lastAssistantContent = msg.content;
                    }
                } catch {
                    // Skip invalid JSON lines
                }
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

    if (messages && Array.isArray(messages)) {
        for (const msg of messages) {
            if (msg.role === 'system' && systemPrompt) continue;
            msgs.push({ role: msg.role, content: msg.content });
        }
    }

    if (prompt && !messages?.some(m => m.content === prompt)) {
        msgs.push({ role: 'user', content: prompt });
    }

    if (schema) {
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg) {
            lastMsg.content += '\n\nRespond with valid JSON only.';
        }
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
