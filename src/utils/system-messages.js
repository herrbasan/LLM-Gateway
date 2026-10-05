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

function invalidInstruction(detail) {
    const err = new Error(`Invalid ${detail}`);
    err.status = 400;
    err.type = 'invalid_request_error';
    err.code = 'INVALID_SYSTEM_MESSAGE';
    return err;
}

export function instructionText(message) {
    const { content } = message;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) {
        throw invalidInstruction(`${message.role} message: content must be a string or an array of text parts`);
    }
    return content.map((part) => {
        if (part?.type !== 'text' || typeof part.text !== 'string') {
            throw invalidInstruction(`${message.role} message: only text parts are allowed, got ${JSON.stringify(part?.type)}`);
        }
        return part.text;
    }).join('');
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
