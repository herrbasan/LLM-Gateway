import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

export function createMiniMaxAdapter(config) {
    const { apiKey, endpoint, model } = config;
    
    if (!apiKey) {
        throw new Error('MiniMax adapter requires an apiKey');
    }
    if (!endpoint) {
        throw new Error('MiniMax adapter requires an endpoint');
    }
    if (!model) {
        throw new Error('MiniMax adapter requires a model');
    }
    
    const base = createBaseAdapter('minimax', config, {
        embeddings: false,
        structuredOutput: true,
        streaming: false
    });

    const buildHeaders = () => ({
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    });

    const formatMessages = (messages, prompt, systemPrompt) => {
        const msgs = [];
        
        if (messages && Array.isArray(messages)) {
            for (const m of messages) {
                if (m.role === 'system') continue;
                msgs.push({
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: m.content
                });
            }
        }
        
        if (prompt && msgs.length === 0) {
            msgs.push({ role: 'user', content: prompt });
        }
        
        return msgs;
    };

    const extractSystemPrompt = (messages, systemPrompt) => {
        if (systemPrompt) return systemPrompt;
        if (!messages || !Array.isArray(messages)) return null;
        const sysMsg = messages.find(m => m.role === 'system');
        return sysMsg ? sysMsg.content : null;
    };

    return {
        ...base,

        async resolveModel(requestedModel) {
            return requestedModel === 'auto' || !requestedModel ? model : requestedModel;
        },

        async predict({ prompt, systemPrompt, maxTokens, temperature, schema, messages }) {
            const body = {
                model,
                messages: formatMessages(messages, prompt, systemPrompt),
                max_tokens: maxTokens ?? 2048,
                temperature: temperature ?? 0.7
            };

            const sys = extractSystemPrompt(messages, systemPrompt);
            if (sys) {
                body.system = sys;
            }

            if (schema && base.capabilities.structuredOutput) {
                body.response_format = {
                    type: 'json_schema',
                    json_schema: {
                        name: 'response',
                        strict: true,
                        schema
                    }
                };
            }

            const res = await request(`${endpoint}/v1/messages`, {
                method: 'POST',
                headers: buildHeaders(),
                body: JSON.stringify(body)
            });

            const data = await res.json();

            let content = '';
            if (data.content && data.content.length > 0) {
                const textBlock = data.content.find(b => b.type === 'text');
                if (textBlock) {
                    content = textBlock.text;
                }
            }

            return {
                id: data.id || `minimax-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
                provider: "minimax",
                choices: [{
                    index: 0,
                    message: { role: "assistant", content: content },
                    finish_reason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason
                }],
                usage: {
                    prompt_tokens: data.usage?.input_tokens || 0,
                    completion_tokens: data.usage?.output_tokens || 0,
                    total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
                }
            };
        },

        async *streamComplete({ prompt, systemPrompt, maxTokens, temperature, schema, messages }) {
            const result = await this.predict({ prompt, systemPrompt, maxTokens, temperature, schema, messages });
            
            yield {
                id: result.id,
                object: "chat.completion.chunk",
                created: result.created,
                model: result.model,
                choices: [{
                    index: 0,
                    delta: { content: result.choices[0].message.content },
                    finish_reason: "stop"
                }]
            };
        },

        async embedText() {
            throw new Error('MiniMax adapter does not support embeddings');
        },

        async listModels() {
            try {
                const res = await request(`${endpoint}/v1/models`, {
                    headers: buildHeaders()
                });
                const data = await res.json();
                return (data.data || []).map(m => ({
                    id: m.id,
                    object: 'model',
                    owned_by: 'minimax',
                    capabilities: base.capabilities
                }));
            } catch (err) {
                return [];
            }
        },

        async getContextWindow() {
            return config.contextWindow || 8192;
        }
    };
}
