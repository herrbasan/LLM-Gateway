import { spawn } from 'child_process';
import { createBaseAdapter } from './base.js';

export function createKimiCliAdapter(config) {
  const { command, timeout, model } = config;
  
  if (!command) {
    throw new Error('Kimi CLI adapter requires a command');
  }
  if (!model) {
    throw new Error('Kimi CLI adapter requires a model');
  }
  
  const cliTimeout = timeout || 120000;
  
  const base = createBaseAdapter('kimi', config, {
    embeddings: false,
    structuredOutput: false,
    streaming: false
  });

  async function runKimiCli(messages, isJsonMode) {
    // Build JSONL input for stream-json format
    const inputLines = messages.map(m => JSON.stringify(m)).join('\n');
    
    if (process.env.DEBUG_KIMI_CLI === '1') {
      console.error(`[kimi-cli] Messages count: ${messages.length}`);
      console.error(`[kimi-cli] Input: ${inputLines.slice(0, 500)}...`);
    }

    return new Promise((resolve, reject) => {
      const stdout = [];
      const stderr = [];
      
      // Use stream-json format for proper message handling
      const args = [
        '--print',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--final-message-only'
      ];

      const child = spawn(command, args, {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8'
        },
        timeout: cliTimeout,
        shell: false
      });

      // Send messages as JSONL via stdin
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
        
        // Parse JSONL output - find the last assistant message
        try {
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
          
          resolve(lastAssistantContent);
        } catch (err) {
          // Fallback to raw output if JSON parsing fails
          resolve(output);
        }
      });

      child.on('error', err => {
        reject(new Error(`Failed to spawn Kimi CLI: ${err.message}. Is '${command}' installed and in PATH?`));
      });
    });
  }

  function buildMessages(systemPrompt, messages, prompt, schema) {
    const msgs = [];
    
    // Add system message if present
    if (systemPrompt) {
      msgs.push({ role: 'system', content: systemPrompt });
    }
    
    // Add conversation history
    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        if (msg.role === 'system' && systemPrompt) {
          // Skip duplicate system message
          continue;
        }
        msgs.push({ role: msg.role, content: msg.content });
      }
    }
    
    // Add standalone prompt if not already in messages
    if (prompt && !messages?.some(m => m.content === prompt)) {
      msgs.push({ role: 'user', content: prompt });
    }
    
    // Add JSON instruction if needed
    if (schema) {
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg) {
        const jsonInstruction = config.prompts?.jsonInstruction ?? '\n\nRespond with valid JSON only.';
        lastMsg.content += jsonInstruction;
      }
    }
    
    return msgs;
  }

  function extractJson(content) {
    // Try ```json block first
    const jsonBlockMatch = content.match(/```json\s*\n?([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }
    
    // Try any ``` block
    const codeBlockMatch = content.match(/```\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        JSON.parse(codeBlockMatch[1].trim());
        return codeBlockMatch[1].trim();
      } catch {
        // Not valid JSON, continue
      }
    }
    
    // Try to find JSON object/array in output
    const jsonMatch = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      try {
        JSON.parse(jsonMatch[1]);
        return jsonMatch[1];
      } catch {
        // Not valid JSON, return original
      }
    }
    
    return content;
  }

  return {
    ...base,

    async resolveModel(requestedModel) {
      return requestedModel === 'auto' || !requestedModel ? model : requestedModel;
    },

    async predict({ prompt, systemPrompt, maxTokens, temperature, schema, messages }) {
      const msgs = buildMessages(systemPrompt, messages, prompt, schema);
      
      const output = await runKimiCli(msgs, !!schema);
      
      // Extract content
      let content = output;
      if (schema) {
        content = extractJson(output);
      }
      
      return {
        id: `kimi-cli-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        provider: "kimi",
        choices: [{
          index: 0,
          message: { role: "assistant", content: content },
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
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
      throw new Error('Kimi CLI adapter does not support embeddings');
    },

    async listModels() {
      const contextWindow = await this.getContextWindow();
      return [
        { 
          id: model, 
          object: 'model',
          owned_by: 'kimi',
          capabilities: {
            ...base.capabilities,
            context_window: contextWindow
          }
        }
      ];
    },

    async getContextWindow() {
      // Kimi k2.5 has 256K context window according to docs
      return config.contextWindow || 256000;
    }
  };
}
