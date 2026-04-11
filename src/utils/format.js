export function snakeToCamel(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(snakeToCamel);
    }
    return Object.keys(obj).reduce((acc, key) => {
        const camelKey = key.replace(/([-_][a-z])/g, group =>
            group.toUpperCase().replace('-', '').replace('_', '')
        );
        // Special case mapping if necessary
        if (key === 'preserve_recent') {
            acc['preserveLastN'] = obj[key];
        } else {
            acc[camelKey] = snakeToCamel(obj[key]);
        }
        return acc;
    }, {});
}

export function camelToSnake(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(camelToSnake);
    }
    return Object.keys(obj).reduce((acc, key) => {
        const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        if (key === 'preserveLastN') {
            acc['preserve_recent'] = obj[key];
        } else {
            acc[snakeKey] = camelToSnake(obj[key]);
        }
        return acc;
    }, {});
}

// ============================================================================
// Thinking Content Stripper
// ============================================================================

/**
 * Default thinking tags used by major LLM models:
 * - DeepSeek R1: <think>...</think>
 * - Qwen/QwQ: <think>...</think>
 * - Some Claude outputs: <thinking>...</thinking>
 * - General reasoning models: <analysis>, <reasoning>, <thought>, <thoughts>
 * - Chain-of-thought: <chain_of_thought>, <cot>
 */
export const DEFAULT_THINKING_TAGS = [
    'think',        // DeepSeek, Qwen, common
    'thinking',     // Claude (some versions)
    'thought',      // Generic
    'thoughts',     // Plural variant
    'analysis',     // Generic
    'reasoning',    // Generic
    'chain_of_thought', // CoT explicit
    'cot'           // CoT short
];

/**
 * Default thinking stripper configuration
 */
export const DEFAULT_THINKING_CONFIG = {
    tags: DEFAULT_THINKING_TAGS,
    // If true, orphan close tags (</tag> without opening) treat everything before as thinking
    // This handles "separator style" where content before the first close tag is considered thinking
    orphanCloseAsSeparator: true,
    // Max thinking content size in characters before flagging excessive thinking (~2K tokens)
    maxThinkingContent: 8192
};

function createThinkingStripper(config = {}) {
    // Normalize config - handle null/undefined properly
    const normalizedConfig = config && typeof config === 'object' && !Array.isArray(config)
        ? { ...DEFAULT_THINKING_CONFIG, ...config }
        : { ...DEFAULT_THINKING_CONFIG, tags: config || DEFAULT_THINKING_TAGS };

    const tags = normalizedConfig.tags;
    const orphanCloseAsSeparator = normalizedConfig.orphanCloseAsSeparator;
    const maxThinkingContent = normalizedConfig.maxThinkingContent;

    const maxBuffer = 16384;
    let buffer = '';
    let inTag = null;
    let thinkingContentSize = 0;
    let thinkingExceeded = false;
    let tagOpenedAt = 0;

    const closeNeedleFor = (tagLower) => `</${tagLower}>`;

    const isOpenTagAt = (text, idx, tagLower) => {
        if (text[idx] !== '<') return false;
        if (text[idx + 1] !== tagLower[0]) return false;
        const after = text[idx + 1 + tagLower.length];
        return after === '>' || after === ' ' || after === '\t' || after === '\r' || after === '\n' || after === '/';
    };

    const findNextOpen = () => {
        const lower = buffer.toLowerCase();
        let bestIdx = -1, bestTag = null;
        for (const tag of tags) {
            const tagLower = String(tag).toLowerCase();
            let idx = lower.indexOf(`<${tagLower}`);
            while (idx !== -1) {
                if (isOpenTagAt(lower, idx, tagLower)) break;
                idx = lower.indexOf(`<${tagLower}`, idx + 1);
            }
            if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
                bestIdx = idx;
                bestTag = tagLower;
            }
        }
        return bestIdx === -1 ? null : { idx: bestIdx, tag: bestTag };
    };

    const findNextClose = (currentTag) => {
        const lower = buffer.toLowerCase();
        let bestIdx = -1, bestTag = null;
        for (const tag of tags) {
            const tagLower = String(tag).toLowerCase();
            const idx = lower.indexOf(closeNeedleFor(tagLower));
            if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
                // When inside a specific thinking block, only consider matching close tag
                // Other close tags should be treated as regular text, not orphans
                if (currentTag && tagLower !== currentTag) continue;
                bestIdx = idx;
                bestTag = tagLower;
            }
        }
        return bestIdx === -1 ? null : { idx: bestIdx, tag: bestTag };
    };

    const trackThinking = (size) => {
        if (inTag && maxThinkingContent) {
            thinkingContentSize += size;
            if (!thinkingExceeded && thinkingContentSize > maxThinkingContent) {
                thinkingExceeded = true;
                console.warn(`[ThinkingStripper] Thinking content exceeded ${maxThinkingContent} chars (${thinkingContentSize} chars, ~${Math.floor(thinkingContentSize / 4)} tokens)`);
            }
        }
    };

    return {
        process(text) {
            if (!text) return '';
            buffer += String(text);
            if (buffer.length > maxBuffer) buffer = buffer.slice(-maxBuffer);

            let out = '';
            while (true) {
                if (inTag) {
                    const closeNeedle = closeNeedleFor(inTag);
                    const closeIdx = buffer.toLowerCase().indexOf(closeNeedle);
                    if (closeIdx === -1) {
                        // Track thinking content size for unclosed tag
                        trackThinking(buffer.length);
                        // Keep only enough chars to detect the close tag at the boundary
                        buffer = buffer.slice(-(closeNeedle.length - 1));
                        break;
                    }
                    // Track the thinking content that was stripped
                    trackThinking(closeIdx);
                    buffer = buffer.slice(closeIdx + closeNeedle.length);
                    inTag = null;
                    continue;
                }

                const nextOpen = findNextOpen();
                const nextClose = findNextClose(inTag);

                // Orphan close tag handling
                // Only apply when not already in a thinking block - if we're inside a block,
                // the inTag handling above takes precedence
                if (orphanCloseAsSeparator && !inTag && nextClose && (!nextOpen || nextClose.idx < nextOpen.idx)) {
                    buffer = buffer.slice(nextClose.idx + closeNeedleFor(nextClose.tag).length);
                    continue;
                }

                if (!nextOpen) break;

                if (nextOpen.idx > 0) {
                    out += buffer.slice(0, nextOpen.idx);
                    buffer = buffer.slice(nextOpen.idx);
                }

                const gt = buffer.indexOf('>');
                if (gt === -1) break;

                tagOpenedAt = buffer.length;
                buffer = buffer.slice(gt + 1);
                inTag = nextOpen.tag;
            }

            return out;
        },
        flush() {
            if (inTag) {
                const thinkingTokens = Math.floor(thinkingContentSize / 4);
                const reason = thinkingExceeded
                    ? `excessive thinking (${thinkingContentSize} chars, ~${thinkingTokens} tokens)`
                    : `unclosed <${inTag}> tag (${thinkingContentSize} chars, ~${thinkingTokens} tokens)`;
                console.warn(`[ThinkingStripper] Flush with ${reason} — thinking content discarded`);
                buffer = '';
                inTag = null;
                thinkingContentSize = 0;
                thinkingExceeded = false;
                return '';
            }
            const out = buffer;
            buffer = '';
            inTag = null;
            thinkingContentSize = 0;
            thinkingExceeded = false;
            return out;
        },
        getStats() {
            return {
                inTag,
                thinkingContentSize,
                thinkingExceeded,
                thinkingTokens: Math.floor(thinkingContentSize / 4)
            };
        }
    };
}

/**
 * Strip thinking content from text
 * @param {string} text - Input text
 * @param {string[]|Object} config - Array of tags or config object {tags: string[], orphanCloseAsSeparator: boolean}
 * @returns {string} Text with thinking content removed
 */
export function stripThinking(text, config = {}) {
    if (!text || typeof text !== 'string') return text;
    
    // Backward compatibility: if config is an array, treat it as tags
    const normalizedConfig = Array.isArray(config) 
        ? { ...DEFAULT_THINKING_CONFIG, tags: config }
        : { ...DEFAULT_THINKING_CONFIG, ...config };
    
    const stripper = createThinkingStripper(normalizedConfig);
    const result = stripper.process(text) + stripper.flush();
    return result.trim();
}

export { createThinkingStripper };
