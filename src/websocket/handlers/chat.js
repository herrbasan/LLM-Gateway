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

  _injectMediaStreams(connection, messages) {
    const usedStreams = new Set();
    const processedMessages = JSON.parse(JSON.stringify(messages || [])); // deep copy

    const replaceMediaUrl = (url) => {
      const match = url.match(/^gateway-media:\/\/([a-zA-Z0-9_-]+)$/);
      if (match) {
        const streamId = match[1];
        if (connection.mediaStreams && connection.mediaStreams.has(streamId)) { 
          const stream = connection.mediaStreams.get(streamId);
          usedStreams.add(streamId);
          const buffer = Buffer.concat(stream.chunks || []);
          return `data:${stream.mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
        }
      }
      return url;
    };

    for (const msg of processedMessages) {
      if (typeof msg.content === 'string') {
        msg.content = msg.content.replace(/gateway-media:\/\/([a-zA-Z0-9_-]+)/g, (match, streamId) => {
          if (connection.mediaStreams && connection.mediaStreams.has(streamId)) {
            const stream = connection.mediaStreams.get(streamId);
            usedStreams.add(streamId);
            const buffer = Buffer.concat(stream.chunks);
            return `data:${stream.mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
          }
          return match;
        });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            part.image_url.url = replaceMediaUrl(part.image_url.url);
          } else if (part.type === 'image' && part.url) {
            part.url = replaceMediaUrl(part.url);
          } else if (part.type === 'text' && typeof part.text === 'string') {
            part.text = part.text.replace(/gateway-media:\/\/([a-zA-Z0-9_-]+)/g, (match, streamId) => {
              if (connection.mediaStreams && connection.mediaStreams.has(streamId)) {
                const stream = connection.mediaStreams.get(streamId);
                usedStreams.add(streamId);
                const buffer = Buffer.concat(stream.chunks);
                return `data:${stream.mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
              }
              return match;
            });
          }
        }
      }
    }

    return { processedMessages, usedStreams };
  }

  async _handleChatCompletion(connection, id, params, messages, model) {
    // Inject proxy media streams
    const { processedMessages, usedStreams } = this._injectMediaStreams(connection, messages);

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
        stream: true,
        signal: requestContext.abortController.signal,
        ...params,
        messages: processedMessages // Needs to be after params to prevent overwriting
      };

      const resolvedModel = this.modelRouter.registry.resolveModel(model, 'chat');
      if (resolvedModel) {
        // Emit model routing status to the client
        connection.ws.send(formatNotification('chat.progress', {
          request_id: id,
          phase: 'model_routed',
          model: resolvedModel.id,
          provider: resolvedModel.adapter ? resolvedModel.adapter.name : 'unknown'
        }));
      }

      // Progress context
      connection.ws.send(formatNotification('chat.progress', {
        request_id: id,
        phase: 'context'
      }));

      const result = await this.modelRouter.routeChatCompletion(requestObject);

      const initialContext = result?.context || {
        window_size: 8192,
        used_tokens: 0,
        available_tokens: 8192,
        strategy_applied: false
      };

      if (result && result.context) {
        connection.ws.send(formatNotification('chat.progress', {
          request_id: id,
          phase: 'context_stats',
          context: initialContext
        }));
      }

      let fullAssistantResponse = '';
      let finalUsage = null;
      let chunkCounter = 0;

      if (result && typeof result.generator !== 'undefined') {
        for await (const chunk of result.generator) {
          if (requestContext.state === RequestState.CANCELLED) {
            break;
          }

          // Apply Backpressure: Yield if the websocket internal buffer is full (e.g. > 64KB)
          let throttled = false;
          while (connection.ws.bufferedAmount && connection.ws.bufferedAmount > 65536) {
            if (!throttled) {
              connection.ws.send(formatNotification('chat.progress', {
                request_id: id,
                phase: 'network_throttled',
                message: 'Buffering downstream...'
              }));
              throttled = true;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
          }

          let content = '';
          let chunkChoices = [];

          if (typeof chunk === 'string') {
            content = chunk;
            chunkChoices = [{ index: 0, delta: { content } }];
          } else if (chunk) {
            if (chunk.choices && chunk.choices.length > 0) {
              const delta = chunk.choices[0].delta || {};
              content = delta.content || '';
              
              // Forward reasoning/thinking markers explicitly as progress events
              if (delta.reasoning_content && !requestContext.hasEmittedReasoning) {
                requestContext.hasEmittedReasoning = true;
                connection.ws.send(formatNotification('chat.progress', {
                  request_id: id,
                  phase: 'reasoning_started',
                  message: 'Model is thinking...'
                }));
              }
              
              chunkChoices = chunk.choices;
            }
            if (chunk.usage) {
              finalUsage = chunk.usage;
            }
          }

          if (content) {
            fullAssistantResponse += content;
          }

          connection.ws.send(formatNotification('chat.delta', {
            request_id: id,
            choices: chunkChoices
          }));
          requestContext.chunksSent++;
          chunkCounter++;

          // Periodically update context stats during streaming to reflect output tokens
          if (chunkCounter % 15 === 0) {
            const tempOutputTokens = Math.ceil(fullAssistantResponse.length * 0.25);
            const currentTotal = initialContext.used_tokens + tempOutputTokens;
            connection.ws.send(formatNotification('chat.progress', {
              request_id: id,
              phase: 'context_stats',
              context: {
                ...initialContext,
                used_tokens: currentTotal,
                available_tokens: Math.max(0, initialContext.window_size - currentTotal)
              }
            }));
          }
        }
      } else {
        const content = (typeof result === 'string') ? result : (result?.choices?.[0]?.message?.content || '');
        if (result?.usage) finalUsage = result.usage;
        
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

        // Final context stats update combining prompt and exact output tokens
        let finalOutputTokens = 0;
        if (finalUsage && finalUsage.completion_tokens) {
          finalOutputTokens = finalUsage.completion_tokens;
        } else if (this.modelRouter.tokenEstimator) {
          finalOutputTokens = await this.modelRouter.tokenEstimator.estimate(fullAssistantResponse, null, model);
        } else {
          finalOutputTokens = Math.ceil(fullAssistantResponse.length * 0.25);
        }

        const finalTotalTokens = initialContext.used_tokens + finalOutputTokens;
        connection.ws.send(formatNotification('chat.progress', {
             request_id: id,
             phase: 'context_stats',
             context: {
                 ...initialContext,
                 used_tokens: finalTotalTokens,
                 available_tokens: Math.max(0, initialContext.window_size - finalTotalTokens)
             }
        }));

        requestContext.transition(RequestState.COMPLETED);
        
        wsMetrics.recordFirstTokenLatency(requestContext.firstTokenLatencyMs / 1000);
        wsMetrics.recordRequestDuration(requestContext.totalLatencyMs / 1000);

        connection.ws.send(formatNotification('chat.done', {
          request_id: id,
          cancelled: false,
          telemetry: {
            time_to_first_token_ms: requestContext.firstTokenLatencyMs,
            total_duration_ms: requestContext.totalLatencyMs,
            usage: finalUsage
          }
        }));
      } else {
        wsMetrics.increment('ws_request_cancelled_total');
        connection.ws.send(formatNotification('chat.done', {
          request_id: id,
          cancelled: true,
          telemetry: {
            total_duration_ms: requestContext.totalLatencyMs
          }
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
      if (connection.mediaStreams) {
        for (const streamId of usedStreams) {
          const stream = connection.mediaStreams.get(streamId);
          if (stream && stream.timeout) clearTimeout(stream.timeout);
          connection.mediaStreams.delete(streamId);
        }
      }
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
