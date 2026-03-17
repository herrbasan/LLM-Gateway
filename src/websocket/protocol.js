// src/websocket/protocol.js
/**
 * JSON-RPC 2.0 Protocol handling for WebSocket Real-Time Mode
 * Reference: Section 4.2 of websocket_realtime_mode.md
 */

export function parseMessage(data) {
  try {
    const text = data.toString('utf-8');
    const message = JSON.parse(text);

    // Validate JSON-RPC 2.0 structure
    if (message.jsonrpc !== '2.0') {
      return { 
        error: createError(null, -32600, 'Invalid Request', 'Missing or invalid jsonrpc version') 
      };
    }

    // Requests must have a method
    if (typeof message.method !== 'string') {
      return { 
        error: createError(message.id, -32600, 'Invalid Request', 'Method must be a string') 
      };
    }

    return { message };
  } catch (err) {
    return { 
      error: createError(null, -32700, 'Parse error', 'Invalid JSON structure') 
    };
  }
}

export function formatResponse(id, result) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: id !== undefined ? id : null,
    result
  });
}

export function formatError(id, code, message, data = null) {
  return JSON.stringify(createError(id, code, message, data));
}

export function formatNotification(method, params) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params
  });
}

function createError(id, code, message, data = null) {
  const errorObj = { code, message };
  if (data !== null) errorObj.data = data;
  
  return {
    jsonrpc: '2.0',
    id: id !== undefined ? id : null,
    error: errorObj
  };
}

// Standard JSON-RPC 2.0 Error Codes
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom server errors
  SERVER_ERROR_BASE: -32000,
  AUTH_REQUIRED: -32001,
  RATE_LIMITED: -32002,
  VALIDATION_FAILED: -32003
};
