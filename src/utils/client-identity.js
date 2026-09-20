// Who is talking to the gateway.
//
// A failure line is only actionable when it says who it happened to. The gateway
// serves several clients — the VS Code BYOK extension, the chat app, subagents,
// scripts — from several machines, and without this an incident arrives as
// "[StreamHandler] HTTP Error 400 ... {model, adapter}": correct, and useless for
// answering "which chat is broken?", which is the first question anyone asks.
//
// Identity comes from two sources:
//   - what every HTTP client sends anyway: remote address and User-Agent;
//   - optional headers a client can send to name itself precisely:
//       X-Client-Name     e.g. "llm-gateway-copilot", "chat-app"
//       X-Client-Version  e.g. "0.3.0"
//       X-Session-Id      the client-side conversation id
//
// None of it is required. A client sending only a User-Agent is still attributed;
// it just cannot be told apart from another window on the same machine, so the
// headers are a contract we want callers to adopt, not a precondition.

const MAX_USER_AGENT_LENGTH = 120;

// Long values are truncated: a client that sends a novel-length User-Agent must
// not be able to inflate every log line in the file.
function header(req, name) {
    const value = req?.headers?.[name];
    if (Array.isArray(value)) return value[0] || null;
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function describeClient(req) {
    if (!req) {
        throw new Error('[client-identity] describeClient requires the request object');
    }

    const userAgent = header(req, 'user-agent');
    const descriptor = {
        ip: req.ip || req.socket?.remoteAddress || null,
        userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null
    };

    const clientName = header(req, 'x-client-name');
    if (clientName) descriptor.clientName = clientName;

    const clientVersion = header(req, 'x-client-version');
    if (clientVersion) descriptor.clientVersion = clientVersion;

    const sessionId = header(req, 'x-session-id');
    if (sessionId) descriptor.sessionId = sessionId;

    return descriptor;
}

// Distinct-client counting in failure aggregation needs a stable identity per
// client *instance*. A named client carrying a session id is exactly that. Two VS
// Code windows on one machine share an address and a User-Agent, so without the
// headers they collapse into one — the reason to adopt them.
export function clientKey(client) {
    if (!client) return 'unknown';
    const parts = [client.clientName || 'unnamed', client.sessionId || client.clientVersion || `${client.ip || '?'}|${client.userAgent || '?'}`];
    return parts.join('|');
}
