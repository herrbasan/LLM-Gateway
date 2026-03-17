import { formatResponse, formatError, formatNotification, ErrorCodes } from '../protocol.js';
import { RequestContext, RequestState } from '../request-state.js';
import { getLogger } from '../../utils/logger.js';
import { wsMetrics } from '../metrics.js';

const logger = getLogger();

export class ChatHandler {
  constructor(router, config, ticketRegistry) {
    this.modelRouter = router;
    this.config = config;
    this.ticketRegistry = ticketRegistry;
  }

  async handleCreate(connection, message) {
    const { id, params } = message;

    if (!params) {
      wsMetrics.increment('ws_errors_total', ErrorCodes.INVALID_PARAMS);
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, 'Missing parameters'));
      return;
    }

    const { messages, model } = params;

    if (!messages || !Array.isArray(messages)) {
      wsMetrics.increment('ws_errors_total', ErrorCodes.INVALID_PARAMS);
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, '"messages" must be an array'));
      return;
    }

    // Reset buffer to provided messages
    connection.conversationBuffer = [...messages];

    return this._handleChatCompletion(connection, id, params, connection.conversationBuffer, model);
  }

  async handleAppend(connection, message) {
    const { id, params } = message;

    if (!params || !params.message) {
      connection.ws.send(formatError(id, ErrorCodes.INVALID_PARAMS, 'Missing parameters (message)'));
      return;
    }

    let model = params.model;
    if (!model) {
       // fallback to last model or a default
       model = 'gemini-flash'; // Or get from session
    }

    connection.conversationBuffer.push(params.message);

    // Max tokens check could be approximated or checked here, we'll keep it simple for now
    const MAX_BUFFER_TOKENS = this.config.websocket?.maxBufferTokens || 200000;
    if (connection.conversationBuffer.length > MAX_BUFFER_TOKENS) {
         // This is a naive limit by length instead of tokens if not tracking tokens
         // A real token estimation would be better
    }

    return this._handleChatCompletion(connection, id, params, connection.conversationBuffer, model);
  }

  async handleSettingsUpdate(connection, message) {
     const { id, params } = message;
     connection.ws.send(formatResponse(id, { updated: true }));
  }

  async _handleChatCompletion(connection, id, params, messages, model) {
    // Set up request context for state machine and multiplexing
    const requestContext = new RequestContext(id, params);
    connection.activeRequests.set(id, requestContext);

    // Initial Processing State
    try {
      requestContext.transition(RequestState.PROCESSING);
      connection.ws.send(formatResponse(id, { accepted: true }));
      
      // Progress routing
      connection.ws.send(formatNotification('chat.progress', {
        request_id: id,
        phase: 'routing'
      }));
    } catch (err) {
      wsMetrics.increment('ws_errors_total', ErrorCodes.INTERNAL_ERROR);
      connection.ws.send(formatError(id, ErrorCodes.INTERNAL_ERROR, 'State transition failed'));
      return;
    }

    try {
      // Fake a stream request to the router
      const requestObject = {
        model,
        messages,
        stream: true,
        signal: requestContext.abortController.signal,
        ...params
      };

      const resolvedModel = this.modelRouter.registry.resolveModel(model, 'chat');
      if (!resolvedModel || resolvedModel.config?.type !== 'chat') {
      }

      // Progress context
      connection.ws.send(formatNotification('chat.progress', {
        request_id: id,
        phase: 'context'
      }));

      const result = await this.modelRouter.routeChatCompletion(requestObject);

      let fullAssistantResponse = '';

      if (result && typeof result.generator !== 'undefined') {
        for await (const chunk of result.generator) {
          if (requestContext.state === RequestState.CANCELLED) {
            break;
          }

          let content = '';
          let chunkChoices = [];

          if (typeof chunk === 'string') {
            content = chunk;
            chunkChoices = [{ index: 0, delta: { content } }];
          } else if (chunk && chunk.choices && chunk.choices.length > 0) {
            content = chunk.choices[0].delta?.content || '';
            chunkChoices = chunk.choices;
          }

          if (content) {
            fullAssistantResponse += content;
          }

          connection.ws.send(formatNotification('chat.delta', {
            request_id: id,
            choices: chunkChoices
          }));
          requestContext.chunksSent++;
        }
      } else {
        const content = (typeof result === 'string') ? result : (result?.choices?.[0]?.message?.content || '');
        fullAssistantResponse = content;
        connection.ws.send(formatNotification('chat.delta', {
          request_id: id,
          choices: [{
            index: 0,
            delta: { content }
          }]
        }));
      }

      if (requestContext.state !== RequestState.CANCELLED) {
        if (fullAssistantResponse) {
          connection.conversationBuffer.push({ role: 'assistant', content: fullAssistantResponse });
        }

        requestContext.transition(RequestState.COMPLETED);
        
        wsMetrics.recordFirstTokenLatency(requestContext.firstTokenLatencyMs / 1000);
        wsMetrics.recordRequestDuration(requestContext.totalLatencyMs / 1000);

        connection.ws.send(formatNotification('chat.done', {
          request_id: id,
          cancelled: false
        }));
      } else {
        wsMetrics.increment('ws_request_cancelled_total');
        connection.ws.send(formatNotification('chat.done', {
          request_id: id,
          cancelled: true
        }));
      }

    } catch (err) {
      if (requestContext.state !== RequestState.CANCELLED && requestContext.state !== RequestState.FAILED) {
        requestContext.transition(RequestState.FAILED);
      }
      wsMetrics.increment('ws_errors_total', ErrorCodes.INTERNAL_ERROR);
      logger.error(`Error in chat.create/append [${id}]:`, err);
      connection.ws.send(formatNotification('chat.error', {
        request_id: id,
        error: { code: ErrorCodes.INTERNAL_ERROR, message: err.message || 'Internal error' }
      }));
    } finally {
      connection.activeRequests.delete(id);
    }
  }

  handleCancel(connection, message) {
    const { params } = message;
    if (!params || !params.request_id) return;

    const requestContext = connection.activeRequests.get(params.request_id);
    if (requestContext) {
      requestContext.cancel();
    }
  }
}
