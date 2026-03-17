import { formatResponse, formatError, ErrorCodes } from '../protocol.js';

export class AuthHandler {
  constructor(config) {
    this.config = config;
  }

  handleInitialize(connection, message) {
    const { id, params } = message;

    if (!connection.auth) connection.auth = {};

    // Already authenticated via upgrade header or local IP auto-auth
    if (connection.auth.authenticated) {
      connection.ws.send(formatResponse(id, {
        status: 'initialized',
        connection_id: connection.id
      }));
      return;
    }

    // Fallback authentication via message params
    const token = params?.access_key;
    const expectedKey = this.config.ws?.accessKey || process.env.GATEWAY_ACCESS_KEY;

    if (expectedKey && token !== expectedKey) {
      connection.ws.send(formatError(id, ErrorCodes.INVALID_REQUEST, 'Invalid access_key'));
      return;
    }

    connection.auth.authenticated = true;

    connection.ws.send(formatResponse(id, {
      status: 'initialized',
      connection_id: connection.id
    }));
  }
}