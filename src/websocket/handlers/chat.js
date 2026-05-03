import { formatResponse, formatError, formatNotification, ErrorCodes } from '../protocol.js';
import { RequestContext, RequestState } from '../request-state.js';
import { getLogger } from '../../utils/logger.js';
import { wsMetrics } from '../metrics.js';
import { isAbortError } from '../../utils/http.js';
import { createThinkingExtractor } from '../../utils/format.js';

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

    // Resolve task defaults if task is specified
    const taskRegistry = this.modelRouter.registry.getTaskRegistry();
    const { resolvedRequest, taskInfo } = taskRegistry.resolveChatRequest({ ...params, model, messages: processedMessages });
    const effectiveModel = resolvedRequest.model || model;
    const effectiveMessages = resolvedRequest.messages || processedMessages;

    // Set up request context for state machine and multiplexing
    const requestContext = new RequestContext(id, params);
    connection.activeRequests.set(id, requestContext);
    logger.info('Request registered', {
      connectionId: connection.id,
      requestId: id,
      model: effectiveModel,
      task: taskInfo?.id || null,
      messageCount: effectiveMessages.length,
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
        phase: 'routing',
        task: taskInfo?.id || null
      }), {
        requestId: id,
        event: 'chat.progress',
        details: { phase: 'routing', task: taskInfo?.id || null }
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
        model: effectiveModel,
        stream: true,
        signal: requestContext.abortController.signal,
        ...resolvedRequest,
        messages: effectiveMessages
      };

      const resolvedModel = this.modelRouter.registry.resolveModel(effectiveModel, 'chat');
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
      const accumulatedToolCalls = {};

      const clientStrip = requestObject.strip_thinking === true || requestObject.no_thinking === true;
      const thinkingExtractor = createThinkingExtractor();

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
            if (chunk.model) requestContext.adapterModel = chunk.model;
            if (chunk.provider) requestContext.adapterProvider = chunk.provider;

            if (chunk.choices && chunk.choices.length > 0) {
              const delta = chunk.choices[0].delta || {};
              const choiceFinishReason = chunk.choices[0].finish_reason;
              
              if (delta) {
                if (delta.content === null) delete delta.content;

                if (delta.content) {
                  const emissions = thinkingExtractor.process(delta.content);

                  if (emissions.length === 0) {
                    delete delta.content;
                  } else if (emissions.length === 1) {
                    if (emissions[0].content !== undefined) {
                      delta.content = emissions[0].content || undefined;
                    } else {
                      delete delta.content;
                    }
                    if (emissions[0].reasoning_content !== undefined) {
                      delta.reasoning_content = emissions[0].reasoning_content;
                    }
                  } else {
                    for (let i = 0; i < emissions.length - 1; i++) {
                      const preDelta = {};
                      if (emissions[i].content !== undefined) preDelta.content = emissions[i].content;
                      if (emissions[i].reasoning_content !== undefined) preDelta.reasoning_content = emissions[i].reasoning_content;
                      if (delta.role) preDelta.role = delta.role;
                      if (delta.function_call) preDelta.function_call = delta.function_call;

                      this._sendWsMessage(connection, formatNotification('chat.delta', {
                        request_id: id,
                        choices: [{ index: 0, delta: preDelta, finish_reason: null }]
                      }), {
                        requestId: id,
                        event: 'chat.delta',
                        details: {
                          chunkIndex: requestContext.chunksSent + 1,
                          contentChars: preDelta.content?.length || 0,
                          accumulatedChars: fullAssistantResponse.length,
                          choices: 1
                        }
                      });
                      requestContext.chunksSent++;
                    }

                    const last = emissions[emissions.length - 1];
                    if (last.content !== undefined) {
                      delta.content = last.content || undefined;
                    } else {
                      delete delta.content;
                    }
                    if (last.reasoning_content !== undefined) {
                      delta.reasoning_content = last.reasoning_content;
                    }
                  }
                }

                if (clientStrip && delta.reasoning_content !== undefined) {
                  delete delta.reasoning_content;
                }
              }

              content = delta.content || '';
              
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
              
              if (choiceFinishReason) {
                requestContext.finishReason = choiceFinishReason;
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

          if (chunk.choices?.[0]?.delta?.tool_calls) {
            for (const tc of chunk.choices[0].delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accumulatedToolCalls[idx]) {
                accumulatedToolCalls[idx] = {
                  id: tc.id || '',
                  type: tc.type || 'function',
                  function: { name: tc.function?.name || '', arguments: '' }
                };
              }
              if (tc.id) accumulatedToolCalls[idx].id = tc.id;
              if (tc.function?.name) accumulatedToolCalls[idx].function.name = tc.function.name;
              if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
            }
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

        if (requestContext.state !== RequestState.CANCELLED) {
          const flushEmissions = thinkingExtractor.flush();
          for (const emission of flushEmissions) {
            const flushDelta = {};
            if (emission.content !== undefined) flushDelta.content = emission.content;
            if (emission.reasoning_content !== undefined) flushDelta.reasoning_content = emission.reasoning_content;

            if (flushDelta.content || flushDelta.reasoning_content) {
              fullAssistantResponse += flushDelta.content || '';
              this._sendWsMessage(connection, formatNotification('chat.delta', {
                request_id: id,
                choices: [{ index: 0, delta: flushDelta }]
              }), {
                requestId: id,
                event: 'chat.delta',
                details: {
                  chunkIndex: requestContext.chunksSent + 1,
                  contentChars: flushDelta.content?.length || 0,
                  accumulatedChars: fullAssistantResponse.length,
                  choices: 1
                }
              });
              requestContext.chunksSent++;
            }
          }
        }
      } else {
        const content = (typeof result === 'string') ? result : (result?.choices?.[0]?.message?.content || '');
        if (result?.usage) finalUsage = result.usage;
        if (result?.model) requestContext.adapterModel = result.model;
        if (result?.provider) requestContext.adapterProvider = result.provider;
        if (result?.choices?.[0]?.finish_reason) requestContext.finishReason = result.choices[0].finish_reason;
        
        fullAssistantResponse = content;

        const msgToolCalls = result?.choices?.[0]?.message?.tool_calls;
        if (msgToolCalls) {
          msgToolCalls.forEach((tc, idx) => {
            accumulatedToolCalls[idx] = { ...tc };
          });
        }

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
        const toolCallsArray = Object.keys(accumulatedToolCalls).length > 0
          ? Object.keys(accumulatedToolCalls).sort((a, b) => Number(a) - Number(b)).map(k => accumulatedToolCalls[k])
          : null;

        if (fullAssistantResponse || toolCallsArray) {
          const assistantMsg = { role: 'assistant', content: fullAssistantResponse || null };
          if (toolCallsArray) assistantMsg.tool_calls = toolCallsArray;
          connection.conversationBuffer.push(assistantMsg);
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
          finish_reason: requestContext.finishReason,
          content: fullAssistantResponse || null,
          tool_calls: toolCallsArray,
          model: requestContext.adapterModel,
          provider: requestContext.adapterProvider,
          telemetry: {
            time_to_first_token_ms: requestContext.firstTokenLatencyMs,
            total_duration_ms: requestContext.totalLatencyMs,
            chunks_sent: requestContext.chunksSent,
            usage: finalUsage,
            reasoning_produced: requestContext.hasEmittedReasoning
          }
        }), {
          requestId: id,
          event: 'chat.done',
          details: {
            cancelled: false,
            chunksSent: requestContext.chunksSent,
            responseChars: fullAssistantResponse.length,
            finishReason: requestContext.finishReason,
            model: requestContext.adapterModel,
            provider: requestContext.adapterProvider,
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
          finish_reason: requestContext.finishReason || 'cancel',
          model: requestContext.adapterModel,
          provider: requestContext.adapterProvider,
          telemetry: {
            total_duration_ms: requestContext.totalLatencyMs,
            chunks_sent: requestContext.chunksSent,
            usage: finalUsage
          }
        }), {
          requestId: id,
          event: 'chat.done',
          details: {
            cancelled: true,
            chunksSent: requestContext.chunksSent,
            responseChars: fullAssistantResponse.length,
            finishReason: requestContext.finishReason,
            model: requestContext.adapterModel,
            provider: requestContext.adapterProvider
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
          finish_reason: requestContext.finishReason || 'cancel',
          model: requestContext.adapterModel,
          provider: requestContext.adapterProvider,
          telemetry: {
            total_duration_ms: requestContext.totalLatencyMs,
            chunks_sent: requestContext.chunksSent
          }
        }), {
          requestId: id,
          event: 'chat.done',
          details: {
            cancelled: true,
            chunksSent: requestContext.chunksSent,
            aborted: true,
            error: err.message,
            finishReason: requestContext.finishReason,
            model: requestContext.adapterModel,
            provider: requestContext.adapterProvider
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
      summary.finishReason = params.finish_reason ?? null;
      summary.model = params.model ?? null;
      summary.provider = params.provider ?? null;
      summary.usage = params.telemetry?.usage ? {
        prompt: params.telemetry.usage.prompt_tokens,
        completion: params.telemetry.usage.completion_tokens
      } : null;
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
