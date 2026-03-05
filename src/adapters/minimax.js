import { createBaseAdapter } from './base.js';
import { request } from '../utils/http.js';

// Static Minimax models list - ensures models are always available even if API fetch fails
// Note: owned_by is set dynamically in listModels() using config.providerName
const MINIMAX_MODELS = [
    {
        id: "minimax-text-01",
        object: "model",
        capabilities: {
            context_window: 8192,
            structured_output: true
        }
    },
    {
        id: "minimax-pro",
        object: "model",
        capabilities: {
            context_window: 16384,
            structured_output: true
        }
    },
    {
        id: "MiniMax-M2.5",
        object: "model",
        capabilities: {
            context_window: 8192,
            structured_output: true
        }
    }
];

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
                provider: config.providerName || "minimax",
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
            // Always return static models as the primary source
            // This ensures consistent model listing with proper metadata
            const providerName = config.providerName || 'minimax';
            const contextWindow = await this.getContextWindow();
            
            const staticModels = MINIMAX_MODELS.map(m => ({
                ...m,
                owned_by: providerName,
                capabilities: {
                    ...m.capabilities,
                    context_window: contextWindow,
                    embeddings: base.capabilities.embeddings,
                    streaming: base.capabilities.streaming
                }
            }));

            // Try to fetch additional models from API, but don't fail if unavailable
            try {
                const res = await request(`${endpoint}/v1/models`, {
                    headers: buildHeaders()
                });
                const data = await res.json();
                const apiModels = (data.data || []).map(m => ({
                    id: m.id,
                    object: 'model',
                    owned_by: config.providerName || 'minimax',
                    capabilities: {
                        context_window: m.context_window || 8192,
                        structured_output: base.capabilities.structuredOutput,
                        embeddings: base.capabilities.embeddings,
                        streaming: base.capabilities.streaming
                    }
                }));
                
                // Merge API models with static models (avoiding duplicates)
                const existingIds = new Set(staticModels.map(m => m.id));
                const newModels = apiModels.filter(m => !existingIds.has(m.id));
                return [...staticModels, ...newModels];
            } catch (err) {
                // Return static models if API fetch fails
                return staticModels;
            }
        },

        async getContextWindow() {
            // MiniMax supports massive 200k+ context windows according to docs
            // No public API to fetch this dynamically, use documented value or config
            return config.contextWindow || 200000;
        }
    };
}
