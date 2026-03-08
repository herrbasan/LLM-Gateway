/**
 * Config validation schema for model-centric architecture.
 * Explicit validation - fails fast on invalid config.
 */

const MODEL_TYPES = ['chat', 'embedding', 'image', 'audio', 'video'];

const REQUIRED_MODEL_FIELDS = ['type', 'adapter', 'capabilities'];

const ADAPTER_TYPES = ['gemini', 'openai', 'ollama', 'lmstudio', 'anthropic', 'kimi-cli'];

/**
 * Validates a model configuration object.
 * Throws on invalid config - no silent failures.
 */
export function validateModelConfig(modelId, config) {
    if (!modelId || typeof modelId !== 'string') {
        throw new Error('[Config] Model ID must be a non-empty string');
    }

    if (!config || typeof config !== 'object') {
        throw new Error(`[Config] Model "${modelId}": config must be an object`);
    }

    // Required fields
    for (const field of REQUIRED_MODEL_FIELDS) {
        if (!(field in config)) {
            throw new Error(`[Config] Model "${modelId}": missing required field "${field}"`);
        }
    }

    // Endpoint is required for all adapters except kimi-cli
    if (config.adapter !== 'kimi-cli' && !config.endpoint) {
        throw new Error(`[Config] Model "${modelId}": endpoint is required for adapter "${config.adapter}"`);
    }

    // Type validation
    if (!MODEL_TYPES.includes(config.type)) {
        throw new Error(`[Config] Model "${modelId}": invalid type "${config.type}". Must be one of: ${MODEL_TYPES.join(', ')}`);
    }

    // Adapter validation
    if (!ADAPTER_TYPES.includes(config.adapter)) {
        throw new Error(`[Config] Model "${modelId}": unknown adapter "${config.adapter}". Must be one of: ${ADAPTER_TYPES.join(', ')}`);
    }

    // Endpoint validation (not required for kimi-cli which uses CLI commands)
    if (config.adapter !== 'kimi-cli') {
        if (typeof config.endpoint !== 'string' || !config.endpoint.startsWith('http')) {
            throw new Error(`[Config] Model "${modelId}": endpoint must be a valid HTTP URL`);
        }
    }

    // Capabilities validation by type
    validateCapabilities(modelId, config.type, config.capabilities);

    return true;
}

/**
 * Validates capabilities based on model type.
 */
function validateCapabilities(modelId, type, capabilities) {
    if (!capabilities || typeof capabilities !== 'object') {
        throw new Error(`[Config] Model "${modelId}": capabilities must be an object`);
    }

    switch (type) {
        case 'chat':
            validateChatCapabilities(modelId, capabilities);
            break;
        case 'embedding':
            validateEmbeddingCapabilities(modelId, capabilities);
            break;
        case 'image':
            validateImageCapabilities(modelId, capabilities);
            break;
        case 'audio':
            validateAudioCapabilities(modelId, capabilities);
            break;
        case 'video':
            validateVideoCapabilities(modelId, capabilities);
            break;
    }
}

function validateChatCapabilities(modelId, caps) {
    if (typeof caps.contextWindow !== 'number' || caps.contextWindow < 1) {
        throw new Error(`[Config] Model "${modelId}": capabilities.contextWindow must be a positive number`);
    }

    // Boolean capabilities
    const boolCaps = ['vision', 'streaming'];
    for (const cap of boolCaps) {
        if (cap in caps && typeof caps[cap] !== 'boolean') {
            throw new Error(`[Config] Model "${modelId}": capabilities.${cap} must be boolean`);
        }
    }

    // structuredOutput can be boolean or string
    if ('structuredOutput' in caps) {
        const valid = typeof caps.structuredOutput === 'boolean' || 
                      caps.structuredOutput === 'json_schema' ||
                      caps.structuredOutput === 'json_object';
        if (!valid) {
            throw new Error(`[Config] Model "${modelId}": capabilities.structuredOutput must be boolean, 'json_schema', or 'json_object'`);
        }
    }
}

function validateEmbeddingCapabilities(modelId, caps) {
    if (typeof caps.contextWindow !== 'number' || caps.contextWindow < 1) {
        throw new Error(`[Config] Model "${modelId}": capabilities.contextWindow must be a positive number`);
    }
    if ('dimensions' in caps && typeof caps.dimensions !== 'number') {
        throw new Error(`[Config] Model "${modelId}": capabilities.dimensions must be a number`);
    }
    if ('batchSize' in caps && typeof caps.batchSize !== 'number') {
        throw new Error(`[Config] Model "${modelId}": capabilities.batchSize must be a number`);
    }
}

function validateImageCapabilities(modelId, caps) {
    if ('maxResolution' in caps && typeof caps.maxResolution !== 'string') {
        throw new Error(`[Config] Model "${modelId}": capabilities.maxResolution must be a string`);
    }
    if ('supportedFormats' in caps && !Array.isArray(caps.supportedFormats)) {
        throw new Error(`[Config] Model "${modelId}": capabilities.supportedFormats must be an array`);
    }
    if ('maxPromptLength' in caps && typeof caps.maxPromptLength !== 'number') {
        throw new Error(`[Config] Model "${modelId}": capabilities.maxPromptLength must be a number`);
    }
}

function validateAudioCapabilities(modelId, caps) {
    // Audio models can have various capabilities - minimal validation
    if ('maxDuration' in caps && typeof caps.maxDuration !== 'number') {
        throw new Error(`[Config] Model "${modelId}": capabilities.maxDuration must be a number`);
    }
}

function validateVideoCapabilities(modelId, caps) {
    if ('maxDuration' in caps && typeof caps.maxDuration !== 'number') {
        throw new Error(`[Config] Model "${modelId}": capabilities.maxDuration must be a number`);
    }
    if ('maxResolution' in caps && typeof caps.maxResolution !== 'string') {
        throw new Error(`[Config] Model "${modelId}": capabilities.maxResolution must be a string`);
    }
}

/**
 * Validates global config sections.
 */
export function validateGlobalConfig(config) {
    // Thinking config
    if (config.thinking) {
        if (typeof config.thinking.enabled !== 'boolean') {
            throw new Error('[Config] thinking.enabled must be boolean');
        }
        if (config.thinking.stripTags && !Array.isArray(config.thinking.stripTags)) {
            throw new Error('[Config] thinking.stripTags must be an array');
        }
    }

    // Compaction config
    if (config.compaction) {
        const validModes = ['truncate', 'rolling', 'none'];
        if (config.compaction.mode && !validModes.includes(config.compaction.mode)) {
            throw new Error(`[Config] compaction.mode must be one of: ${validModes.join(', ')}`);
        }
        if ('minTokensToCompact' in config.compaction && typeof config.compaction.minTokensToCompact !== 'number') {
            throw new Error('[Config] compaction.minTokensToCompact must be a number');
        }
    }

    // Routing config
    if (config.routing) {
        // Routing defaults are optional but must be strings if present
        for (const field of ['defaultChatModel', 'defaultEmbeddingModel', 'defaultImageModel', 'defaultAudioModel', 'defaultVideoModel']) {
            if (field in config.routing && typeof config.routing[field] !== 'string') {
                throw new Error(`[Config] routing.${field} must be a string`);
            }
        }
    }

    return true;
}

/**
 * Validates the complete configuration object.
 * Returns validated config or throws.
 */
export function validateConfig(config) {
    if (!config || typeof config !== 'object') {
        throw new Error('[Config] Config must be an object');
    }

    // Validate models section
    if (!config.models || typeof config.models !== 'object') {
        throw new Error('[Config] Missing or invalid "models" section');
    }

    for (const [modelId, modelConfig] of Object.entries(config.models)) {
        validateModelConfig(modelId, modelConfig);
    }

    // Validate global sections
    validateGlobalConfig(config);

    // Validate that routing defaults point to existing models
    if (config.routing) {
        validateRoutingDefaults(config.routing, Object.keys(config.models));
    }

    return config;
}

function validateRoutingDefaults(routing, availableModels) {
    for (const [key, modelId] of Object.entries(routing)) {
        if (!availableModels.includes(modelId)) {
            throw new Error(`[Config] routing.${key}="${modelId}" does not exist in models`);
        }
    }
}

/**
 * Resolves environment variable placeholders in config values.
 * Supports: ${ENV_VAR} syntax
 */
export function resolveEnvVars(value) {
    if (typeof value !== 'string') {
        return value;
    }

    const envPattern = /\$\{([^}]+)\}/g;
    return value.replace(envPattern, (match, varName) => {
        const envValue = process.env[varName];
        if (envValue === undefined) {
            throw new Error(`[Config] Environment variable "${varName}" is not set`);
        }
        return envValue;
    });
}

/**
 * Deeply resolves environment variables in config object.
 */
export function resolveConfigEnvVars(config) {
    if (typeof config !== 'object' || config === null) {
        return resolveEnvVars(config);
    }

    if (Array.isArray(config)) {
        return config.map(item => resolveConfigEnvVars(item));
    }

    const resolved = {};
    for (const [key, value] of Object.entries(config)) {
        resolved[key] = resolveConfigEnvVars(value);
    }
    return resolved;
}
