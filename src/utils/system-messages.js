import { getLogger } from './logger.js';

const logger = getLogger();

// OpenAI `system`/`developer` messages → providers whose API has a single
// top-level system field (Anthropic `system`, Gemini `system_instruction`).
//
// The leading run is the system prompt. A later one is an instruction the
// client placed at that point in the conversation — Copilot appends one after
// the model's last answer. Deleting it leaves the history ending on the
// model's own answer, which providers read as "continue that answer":
// DeepSeek rejects it with a 400 ("content[].thinking ... must be passed
// back"), Kimi returns a complete but empty answer. It stays where the client
// put it, as a user turn.
const INSTRUCTION_ROLES = new Set(['system', 'developer']);

/**
 * The text of one instruction message. Never refuses: an instruction sits on the
 * history path, where a client resends the same input on every turn, so throwing
 * here ended the session rather than the one request (2026-10-16 policy — the
 * history path repairs or drops and leaves refusing to the provider).
 *
 * A part that is not text is dropped with a WARN: a single top-level system string
 * has nowhere to put an image. Content that is neither a string nor an array of
 * parts is carried as JSON, so words are not lost to a shape surprise.
 */
export function instructionText(message) {
    const { content } = message;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) {
        logger.warn('Instruction message content is neither a string nor an array — carried as JSON', {
            role: message.role,
            contentType: typeof content
        }, 'SystemMessages');
        return JSON.stringify(content ?? '');
    }
    const dropped = [];
    const text = content.map((part) => {
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        dropped.push(part?.type ?? typeof part);
        return '';
    }).join('');
    if (dropped.length > 0) {
        logger.warn('Instruction message parts dropped — only text belongs in a system prompt', {
            role: message.role,
            dropped
        }, 'SystemMessages');
    }
    return text;
}

export function splitInstructions(messages) {
    let start = 0;
    const leading = [];
    while (start < messages.length && INSTRUCTION_ROLES.has(messages[start].role)) {
        leading.push(instructionText(messages[start]));
        start++;
    }
    const rest = messages.slice(start).map(m => (INSTRUCTION_ROLES.has(m.role)
        ? { role: 'user', content: instructionText(m) }
        : m));
    return {
        systemPrompt: leading.length > 0 ? leading.join('\n\n') : null,
        messages: rest
    };
}
