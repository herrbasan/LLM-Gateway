import fs from 'fs';

let content = fs.readFileSync('src/adapters/ollama.js', 'utf8');

content = content.replace(
    'structuredOutput: false, // Ollama does not natively support structured outputs mapping standardly',
    'structuredOutput: true,'
);

content = content.replace(
    'const buildPayload = ({ prompt, systemPrompt, maxTokens, temperature, messages, stream }, requestedModel = \'auto\') => {',
    'const buildPayload = ({ prompt, systemPrompt, maxTokens, temperature, schema, messages, stream }, requestedModel = \'auto\') => {'
);

content = content.replace(
    'if (typeof temperature === \'number\') payload.options.temperature = temperature;',
    'if (typeof temperature === \'number\') payload.options.temperature = temperature;\n        if (schema && defaultCapabilities.structuredOutput) payload.format = schema;'
);

fs.writeFileSync('src/adapters/ollama.js', content, 'utf8');

let openaiContent = fs.readFileSync('src/adapters/openai.js', 'utf8');

openaiContent = openaiContent.replace(
    'if (maxTokens) payload.max_tokens = maxTokens;\n        if (typeof temperature === \'number\') payload.temperature = temperature;',
    `if (maxTokens) payload.max_tokens = maxTokens;
        if (typeof temperature === 'number') payload.temperature = temperature;
        
        // Strip parameters for Grok-4 reasoning constraints
        if (apiEndpoint.includes('x.ai') && payload.model.includes('grok-4')) {
            delete payload.temperature;
            delete payload.presence_penalty;
            delete payload.frequency_penalty;
            delete payload.stop;
        }

        // Handle Zhipu (GLM) constraint preventing both temperature and top_p natively
        if (apiEndpoint.includes('z.ai')) {
             if (payload.temperature !== undefined && payload.top_p !== undefined) {
                  delete payload.top_p;
             }
        }`
);

fs.writeFileSync('src/adapters/openai.js', openaiContent, 'utf8');
console.log('Adapters updated successfully');