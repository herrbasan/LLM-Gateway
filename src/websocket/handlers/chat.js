import { formatResponse, formatError, formatNotification, ErrorCodes } from '../protocol.js';
import { RequestContext, RequestState } from '../request-state.js';
import { getLogger } from '../../utils/logger.js';
import { wsMetrics } from '../metrics.js';
import { isAbortError } from '../../utils/http.js';
import { createThinkingStripper } from '../../utils/format.js';

const logger = getLogger();

export class ChatHandler {
  constructor(router, config, ticketRegistry) {
    this.modelRouter = router;
    this.config = config;
    this.ticketRegistry = ticketRegistry;
  }

  async handleCreate(connection, message) {
    const { id, params } = message;
    connection.lastActive = Date.now();

    if (!params) {
      wsMetrics.increment('ws_errors_total', ErrorCodes.INVALID_PARAMS);
      this._sendWsMessage(connection, formatError(id, ErrorCodes.INVALID_PARAMS, 'Missing parameters'), {
        requestId: id,
        event: 'error_response',
        details: { code: ErrorCodes.INVALID_PARAMS, reason: 'Missing parameters' }
      });
      return;
    }

    const { messages, model } = params;

    if (!messages || !Array.isArray(messages)) {
      wsMetrics.increment('ws_errors_total', ErrorCodes.INVALID_PARAMS);
      this._sendWsMessage(connection, formatError(id, ErrorCodes.INVALID_PARAMS, '"messages" must be an array'), {
        requestId: id,
        event: 'error_response',
        details: { code: ErrorCodes.INVALID_PARAMS, reason: 'messages must be an array' }
      });
      return;
    }

    // Reset buffer to provided messages
    connection.conversationBuffer = [...messages];

    return this._handleChatCompletion(connection, id, params, connection.conversationBuffer, model);
  }

  async handleAppend(connection, message) {
    const { id, params } = message;
    connection.lastActive = Date.now();

    if (!params || !params.message) {
      this._sendWsMessage(connection, formatError(id, ErrorCodes.INVALID_PARAMS, 'Missing parameters (message)'), {
        requestId: id,
        event: 'error_response',
        details: { code: ErrorCodes.INVALID_PARAMS, reason: 'Missing parameters (message)' }
      });
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
      connection.lastActive = Date.now();
      this._sendWsMessage(connection, formatResponse(id, { updated: true }), {
       requestId: id,
       event: 'response',
       details: { updated: true }
      });
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
    logger.info('Request registered', {
      connectionId: connection.id,
      requestId: id,
      model,
      messageCount: processedMessages.length,
      activeRequests: connection.activeRequests.size,
      readyState: describeReadyState(connection.ws.readyState)
    });

    // Initial Processing State
    try {
      requestContext.transition(RequestState.PROCESSING);
      this._sendWsMessage(connection, formatResponse(id, { accepted: true }), {
        requestId: id,
        event: 'response',
        details: { accepted: true }
      });
      
      // Progress routing
      this._sendWsMessage(connection, formatNotification('chat.progress', {
        request_id: id,
        phase: 'routing'
      }), {
        requestId: id,
        event: 'chat.progress',
        details: { phase: 'routing' }
      });
    } catch (err) {
      wsMetrics.increment('ws_errors_total', ErrorCodes.INTERNAL_ERROR);
      this._sendWsMessage(connection, formatError(id, ErrorCodes.INTERNAL_ERROR, 'State transition failed'), {
        requestId: id,
        event: 'error_response',
        details: { code: ErrorCodes.INTERNAL_ERROR, reason: 'State transition failed' }
      });
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
        this._sendWsMessage(connection, formatNotification('chat.progress', {
          request_id: id,
          phase: 'model_routed',
          model: resolvedModel.id,
          provider: resolvedModel.adapter ? resolvedModel.adapter.name : 'unknown'
        }), {
          requestId: id,
          event: 'chat.progress',
          details: {
            phase: 'model_routed',
            model: resolvedModel.id,
            provider: resolvedModel.adapter ? resolvedModel.adapter.name : 'unknown'
          }
        });
      }

      // Progress context
      this._sendWsMessage(connection, formatNotification('chat.progress', {
        request_id: id,
        phase: 'context'
      }), {
        requestId: id,
        event: 'chat.progress',
        details: { phase: 'context' }
      });

      const result = await this.modelRouter.routeChatCompletion(requestObject);

      const initialContext = result?.context || {
        window_size: 8192,
        used_tokens: 0,
        available_tokens: 8192,
        strategy_applied: false
      };

      if (result && result.context) {
        this._sendWsMessage(connection, formatNotification('chat.progress', {
          request_id: id,
          phase: 'context_stats',
          context: initialContext
        }), {
          requestId: id,
          event: 'chat.progress',
          details: {
            phase: 'context_stats',
            used_tokens: initialContext.used_tokens,
            available_tokens: initialContext.available_tokens,
            resolved_max_tokens: initialContext.resolved_max_tokens ?? null
          }
        });
      }

      let finalUsage = null;
      let fullAssistantResponse = '';

      const globalThinkingConfig = this.modelRouter.registry.getThinkingConfig();
      const clientStrip = requestObject.strip_thinking === true || requestObject.no_thinking === true;
      const shouldStripThinking = clientStrip || globalThinkingConfig.enabled;
      const thinkingStripper = shouldStripThinking ? createThinkingStripper(globalThinkingConfig) : null;

      if (result && typeof result.generator !== 'undefined') {
        for await (const chunk of result.generator) {
          if (requestContext.state === RequestState.CANCELLED) {
            break;
          }

          // Apply Backpressure: Yield if the websocket internal buffer is full (e.g. > 64KB)
          let throttled = false;
          while (connection.ws.bufferedAmount && connection.ws.bufferedAmount > 65536) {
            if (!throttled) {
              this._sendWsMessage(connection, formatNotification('chat.progress', {
                request_id: id,
                phase: 'network_throttled',
                message: 'Buffering downstream...'
              }), {
                requestId: id,
                event: 'chat.progress',
                details: {
                  phase: 'network_throttled',
                  bufferedAmount: connection.ws.bufferedAmount || 0
                }
              });
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
              
              if (delta) {
                if (delta.content && thinkingStripper) {
                  delta.content = thinkingStripper.process(delta.content);
                }
                if (shouldStripThinking && delta.reasoning_content !== undefined) {
                  delete delta.reasoning_content;
                }
              }

              content = delta.content || '';
              
              // Forward reasoning/thinking markers explicitly as progress events
              if (delta.reasoning_content && !requestContext.hasEmittedReasoning) {
                requestContext.hasEmittedReasoning = true;
                this._sendWsMessage(connection, formatNotification('chat.progress', {
                  request_id: id,
                  phase: 'reasoning_started',
                  message: 'Model is thinking...'
                }), {
                  requestId: id,
                  event: 'chat.progress',
                  details: { phase: 'reasoning_started' }
                });
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

          this._sendWsMessage(connection, formatNotification('chat.delta', {
            request_id: id,
            choices: chunkChoices
          }), {
            requestId: id,
            event: 'chat.delta',
            details: {
              chunkIndex: requestContext.chunksSent + 1,
              contentChars: content.length,
              accumulatedChars: fullAssistantResponse.length,
              choices: chunkChoices.length
            }
          });
          requestContext.chunksSent++;
        }

        if (thinkingStripper && requestContext.state !== RequestState.CANCELLED) {
          const remaining = thinkingStripper.flush();
          if (remaining) {
            fullAssistantResponse += remaining;
            this._sendWsMessage(connection, formatNotification('chat.delta', {
              request_id: id,
              choices: [{ index: 0, delta: { content: remaining } }]
            }), {
              requestId: id,
              event: 'chat.delta',
              details: {
                chunkIndex: requestContext.chunksSent + 1,
                contentChars: remaining.length,
                accumulatedChars: fullAssistantResponse.length,
                choices: 1
              }
            });
            requestContext.chunksSent++;
          }
        }
      } else {
        const content = (typeof result === 'string') ? result : (result?.choices?.[0]?.message?.content || '');
        if (result?.usage) finalUsage = result.usage;
        
        fullAssistantResponse = content;
        this._sendWsMessage(connection, formatNotification('chat.delta', {
          request_id: id,
          choices: [{
            index: 0,
            delta: { content }
          }]
        }), {
          requestId: id,
          event: 'chat.delta',
          details: {
            chunkIndex: 1,
            contentChars: content.length,
            accumulatedChars: fullAssistantResponse.length,
            choices: 1
          }
        });
      }

      if (requestContext.state !== RequestState.CANCELLED) {
        if (fullAssistantResponse) {
          connection.conversationBuffer.push({ role: 'assistant', content: fullAssistantResponse });
        }

        requestContext.transition(RequestState.COMPLETED);
        
        wsMetrics.recordFirstTokenLatency(requestContext.firstTokenLatencyMs / 1000);
        wsMetrics.recordRequestDuration(requestContext.totalLatencyMs / 1000);

        logger.info('Request completed before final send', {
          connectionId: connection.id,
          requestId: id,
          chunksSent: requestContext.chunksSent,
          responseChars: fullAssistantResponse.length,
          readyState: describeReadyState(connection.ws.readyState),
          bufferedAmount: connection.ws.bufferedAmount || 0,
          usage: finalUsage
        });

        this._sendWsMessage(connection, formatNotification('chat.done', {
          request_id: id,
          cancelled: false,
          context: initialContext,
          telemetry: {
            time_to_first_token_ms: requestContext.firstTokenLatencyMs,
            total_duration_ms: requestContext.totalLatencyMs,
            usage: finalUsage
          }
        }), {
          requestId: id,
          event: 'chat.done',
          details: {
            cancelled: false,
            chunksSent: requestContext.chunksSent,
            responseChars: fullAssistantResponse.length,
            usage: finalUsage
          }
        });
      } else {
        wsMetrics.increment('ws_request_cancelled_total');
        logger.info('Request cancelled before final send', {
          connectionId: connection.id,
          requestId: id,
          chunksSent: requestContext.chunksSent,
          readyState: describeReadyState(connection.ws.readyState),
          bufferedAmount: connection.ws.bufferedAmount || 0
        });

        this._sendWsMessage(connection, formatNotification('chat.done', {
          request_id: id,
          cancelled: true,
          context: initialContext,
          telemetry: {
            total_duration_ms: requestContext.totalLatencyMs
          }
        }), {
          requestId: id,
          event: 'chat.done',
          details: {
            cancelled: true,
            chunksSent: requestContext.chunksSent,
            responseChars: fullAssistantResponse.length
          }
        });
      }

    } catch (err) {
      if (requestContext.state === RequestState.CANCELLED || isAbortError(err)) {
        if (requestContext.state !== RequestState.CANCELLED) {
          requestContext.cancel();
        }
        wsMetrics.increment('ws_request_cancelled_total');
        logger.info('Request aborted', {
          connectionId: connection.id,
          requestId: id,
          chunksSent: requestContext.chunksSent,
          readyState: describeReadyState(connection.ws.readyState),
          bufferedAmount: connection.ws.bufferedAmount || 0,
          error: err.message
        });

        this._sendWsMessage(connection, formatNotification('chat.done', {
          request_id: id,
          cancelled: true,
          context: null,
          telemetry: {
            total_duration_ms: requestContext.totalLatencyMs
          }
        }), {
          requestId: id,
          event: 'chat.done',
          details: {
            cancelled: true,
            chunksSent: requestContext.chunksSent,
            aborted: true,
            error: err.message
          }
        });
        return;
      }

      if (requestContext.state !== RequestState.CANCELLED && requestContext.state !== RequestState.FAILED) {
        requestContext.transition(RequestState.FAILED);
      }
      wsMetrics.increment('ws_errors_total', ErrorCodes.INTERNAL_ERROR);
      logger.error(`Error in chat.create/append [${id}]:`, err, null, 'ChatHandler');
      this._sendWsMessage(connection, formatNotification('chat.error', {
        request_id: id,
        error: { code: ErrorCodes.INTERNAL_ERROR, message: err.message || 'Internal error' }
      }), {
        requestId: id,
        event: 'chat.error',
        details: { code: ErrorCodes.INTERNAL_ERROR, error: err.message || 'Internal error' }
      });
    } finally {
      logger.info('Request cleanup', {
        connectionId: connection.id,
        requestId: id,
        finalState: requestContext.state,
        activeRequestsBeforeDelete: connection.activeRequests.size,
        chunksSent: requestContext.chunksSent,
        readyState: describeReadyState(connection.ws.readyState),
        bufferedAmount: connection.ws.bufferedAmount || 0
      });

      if (connection.mediaStreams) {
        for (const streamId of usedStreams) {
          const stream = connection.mediaStreams.get(streamId);
          if (stream && stream.timeout) clearTimeout(stream.timeout);
          connection.mediaStreams.delete(streamId);
        }
      }
      connection.activeRequests.delete(id);
      logger.info('Request deregistered', {
        connectionId: connection.id,
        requestId: id,
        activeRequestsRemaining: connection.activeRequests.size
      });
    }
  }

  handleCancel(connection, message) {
    const { params } = message;
    if (!params || !params.request_id) return;

    const requestContext = connection.activeRequests.get(params.request_id);
    if (requestContext) {
      logger.info('Cancel requested', {
        connectionId: connection.id,
        requestId: params.request_id,
        requestState: requestContext.state,
        readyState: describeReadyState(connection.ws.readyState)
      });
      requestContext.cancel();
    } else {
      logger.warn('Cancel requested for unknown request', {
        connectionId: connection.id,
        requestId: params.request_id,
        activeRequests: Array.from(connection.activeRequests.keys())
      });
    }
  }

  _sendWsMessage(connection, payload, metadata = {}) {
    connection.lastActive = Date.now();

    const readyState = connection.ws.readyState;
    const readyStateLabel = describeReadyState(readyState);
    const bufferedAmount = connection.ws.bufferedAmount || 0;
    const summary = summarizePayload(payload);
    const shouldLogAttempt = shouldLogWsSendAttempt(metadata, summary);

    if (shouldLogAttempt) {
      logger.info('WS send attempt', {
        connectionId: connection.id,
        requestId: metadata.requestId || summary.requestId || null,
        event: metadata.event || summary.event,
        readyState: readyStateLabel,
        bufferedAmount,
        payloadBytes: Buffer.byteLength(payload, 'utf8'),
        summary,
        details: metadata.details || null
      });
    }

    if (readyState !== 1) {
      logger.warn('WS send on non-open socket', {
        connectionId: connection.id,
        requestId: metadata.requestId || summary.requestId || null,
        event: metadata.event || summary.event,
        readyState: readyStateLabel,
        bufferedAmount,
        details: metadata.details || null
      });
    }

    try {
      connection.ws.send(payload, (error) => {
        if (error) {
          logger.warn('WS send callback error', {
            connectionId: connection.id,
            requestId: metadata.requestId || summary.requestId || null,
            event: metadata.event || summary.event,
            readyState: describeReadyState(connection.ws.readyState),
            bufferedAmount: connection.ws.bufferedAmount || 0,
            error: error.message
          });
          return;
        }

        if (shouldLogAttempt) {
          logger.info('WS send success', {
            connectionId: connection.id,
            requestId: metadata.requestId || summary.requestId || null,
            event: metadata.event || summary.event,
            readyState: describeReadyState(connection.ws.readyState),
            bufferedAmount: connection.ws.bufferedAmount || 0,
            details: metadata.details || null
          });
        }
      });
    } catch (error) {
      logger.warn('WS send threw synchronously', {
        connectionId: connection.id,
        requestId: metadata.requestId || summary.requestId || null,
        event: metadata.event || summary.event,
        readyState: readyStateLabel,
        bufferedAmount,
        error: error.message
      });
      throw error;
    }
  }
}

function describeReadyState(readyState) {
  switch (readyState) {
    case 0:
      return 'CONNECTING';
    case 1:
      return 'OPEN';
    case 2:
      return 'CLOSING';
    case 3:
      return 'CLOSED';
    default:
      return `UNKNOWN(${readyState})`;
  }
}

function summarizePayload(payload) {
  try {
    const parsed = JSON.parse(payload);
    const params = parsed.params || {};
    const event = parsed.method || (parsed.result ? 'response' : parsed.error ? 'error' : 'unknown');
    const summary = {
      event,
      requestId: parsed.id ?? params.request_id ?? null
    };

    if (parsed.method === 'chat.progress') {
      summary.phase = params.phase || null;
    }

    if (parsed.method === 'chat.delta') {
      const content = params.choices?.[0]?.delta?.content || '';
      summary.contentChars = content.length;
      summary.contentPreview = content.slice(0, 120);
    }

    if (parsed.method === 'chat.done') {
      summary.cancelled = params.cancelled === true;
      summary.totalDurationMs = params.telemetry?.total_duration_ms ?? null;
    }

    if (parsed.method === 'chat.error') {
      summary.errorCode = params.error?.code ?? null;
      summary.errorMessage = params.error?.message ?? null;
    }

    if (parsed.result) {
      summary.resultKeys = Object.keys(parsed.result);
    }

    if (parsed.error) {
      summary.errorCode = parsed.error.code;
      summary.errorMessage = parsed.error.message;
    }

    return summary;
  } catch {
    return {
      event: 'raw',
      requestId: null,
      preview: payload.slice(0, 160)
    };
  }
}

function shouldLogWsSendAttempt(metadata, summary) {
  const event = metadata.event || summary.event;
  const details = metadata.details || {};

  if (event === 'chat.done' || event === 'chat.error' || event === 'error_response' || event === 'response') {
    return true;
  }

  if (event === 'chat.progress') {
    return details.phase === 'network_throttled' || details.phase === 'reasoning_started';
  }

  if (event === 'chat.delta') {
    const chunkIndex = details.chunkIndex || 0;
    return chunkIndex === 1 || chunkIndex % 200 === 0;
  }

  return false;
}
