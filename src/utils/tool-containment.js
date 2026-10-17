import { getLogger } from './logger.js';

const logger = getLogger();

/**
 * Tool containment — a provider rejecting one tool must not kill the turn.
 *
 * A stateless client resends its whole request on every turn. So a request the
 * provider refuses is not one failed call: it is every future call, identically,
 * until the client's own payload changes. A single tool schema the provider dislikes
 * therefore ends a session, which has cost real money and real time (2026-10-17:
 * Gemini refused VS Code's `ask_user` schema and every turn of that conversation).
 *
 * The rule here is "report, don't block": when a provider rejects a request naming a
 * specific tool, that tool is dropped and the request is sent again. The turn
 * completes, the loss is logged at `warn` with the provider's own words, and the tool
 * is remembered per model so later turns do not pay the rejected round trip. The
 * model simply cannot call that tool in this model's conversations.
 *
 * What is deliberately NOT contained: anything that is not a named tool. Authentication,
 * rate limits, context length (the anthropic adapter has its own retry), content
 * refusals, and every message/history problem stay fatal — dropping a message would
 * silently change the conversation, which is a lie about what the model saw.
 */

// Names this model has already refused, so the doomed round trip happens once.
const refused = new Map();

const containmentKey = (adapter, model) => `${adapter}|${model}`;

const toolNameOf = (tool) => tool?.function?.name ?? tool?.name ?? null;

/**
 * The tool a rejection is about, or null.
 *
 * Only a message that both mentions tools/functions AND names one is containment
 * material; everything else is left to fail. Providers word this differently and the
 * wording is measured, not guessed:
 *   Gemini     Invalid schema in function tool 'ask_user' parameters: ...
 *   OpenAI     Invalid schema for function 'ask_user': ...
 *   Anthropic  tools.0.custom.input_schema: ...
 */
export function rejectedToolName(message, payload) {
    if (typeof message !== 'string') return null;
    if (!/tool|function/i.test(message)) return null;

    const quoted = message.match(/function tool '([^']+)'/i)
        ?? message.match(/function '([^']+)'/i)
        ?? message.match(/tool '([^']+)'/i);
    if (quoted) return quoted[1];

    // An index into the tools array we sent — resolvable only against our own payload.
    const indexed = message.match(/tools?[.[](\d+)/i);
    if (indexed && Array.isArray(payload?.tools)) {
        const name = toolNameOf(payload.tools[Number(indexed[1])]);
        if (name) return name;
    }
    return null;
}

/** Remove a tool by name. Returns false when the payload does not offer it. */
export function dropToolByName(payload, name) {
    let dropped = false;
    for (const key of ['tools', 'functions']) {
        if (!Array.isArray(payload?.[key])) continue;
        const kept = payload[key].filter(tool => toolNameOf(tool) !== name);
        if (kept.length !== payload[key].length) {
            dropped = true;
            if (kept.length > 0) payload[key] = kept;
            else delete payload[key];
        }
    }
    if (!dropped) return false;

    // A choice naming a tool that is no longer offered is the same class of failure.
    const choice = payload.tool_choice;
    const chosen = typeof choice === 'string' ? choice : toolNameOf(choice) ?? choice?.function?.name;
    if (chosen === name) delete payload.tool_choice;
    if (Array.isArray(payload.tools) === false) {
        delete payload.tool_choice;
        delete payload.parallel_tool_calls;
    }
    return true;
}

/**
 * Send, and if the provider refuses a named tool, drop it and send once more.
 *
 * `send` takes the payload so the retry can serialize the reduced one. At most three
 * tools are given up on one request — a payload that keeps failing is not a tool
 * problem, and looping would hide it.
 */
export async function sendWithToolContainment({ adapter, model, payload, send }) {
    const key = containmentKey(adapter, model);

    const known = refused.get(key);
    if (known) {
        for (const name of known) {
            if (dropToolByName(payload, name)) {
                logger.debug('Dropped a tool this model refused earlier', { model, tool: name }, 'ToolContainment');
            }
        }
    }

    for (let attempt = 0; ; attempt++) {
        try {
            return await send(payload);
        } catch (error) {
            const name = rejectedToolName(error?.message, payload);
            if (!name || attempt >= 3) throw error;
            if (!dropToolByName(payload, name)) throw error;

            if (!refused.has(key)) refused.set(key, new Set());
            refused.get(key).add(name);

            logger.warn('Provider refused a tool schema — dropped it so the turn can continue', {
                adapter,
                model,
                tool: name,
                remainingTools: Array.isArray(payload.tools) ? payload.tools.length : 0,
                reason: String(error.message).replace(/\s+/g, ' ').slice(0, 300)
            }, 'ToolContainment');
        }
    }
}
