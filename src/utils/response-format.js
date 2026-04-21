export function chatCompletionsToResponse(chatResponse, rawRequest = {}) {
    const id = `resp_${Date.now().toString(16)}${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const created = Math.floor(now / 1000);

    const output = buildOutput(chatResponse);
    const usage = buildUsage(chatResponse);

    return {
        id,
        object: 'response',
        created_at: created,
        status: 'completed',
        completed_at: created,
        error: null,
        incomplete_details: null,
        instructions: rawRequest.instructions || null,
        max_output_tokens: chatResponse.resolved_max_tokens ?? rawRequest.max_output_tokens ?? null,
        model: chatResponse.model || rawRequest.model || 'unknown',
        output,
        parallel_tool_calls: rawRequest.parallel_tool_calls ?? true,
        previous_response_id: rawRequest.previous_response_id || null,
        reasoning: { effort: null, summary: null },
        store: rawRequest.store ?? true,
        temperature: rawRequest.temperature ?? 1.0,
        text: { format: { type: 'text' } },
        tool_choice: rawRequest.tool_choice || 'auto',
        tools: rawRequest.tools || [],
        top_p: rawRequest.top_p ?? 1.0,
        truncation: 'disabled',
        usage,
        user: rawRequest.user || null,
        metadata: rawRequest.metadata || {}
    };
}

function buildOutput(chatResponse) {
    const choice = chatResponse.choices?.[0];
    if (!choice) return [];

    const message = choice.message || {};
    const output = [];
    const msgId = `msg_${Date.now().toString(16)}${Math.random().toString(36).slice(2, 10)}`;

    if (message.tool_calls && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
            output.push({
                type: 'function_call',
                id: `fc_${Date.now().toString(16)}${Math.random().toString(36).slice(2, 10)}`,
                call_id: tc.id || `call_${Math.random().toString(36).slice(2, 11)}`,
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '{}',
                status: 'completed'
            });
        }
    }

    if (message.content || (!message.tool_calls && !message.content)) {
        const msgContent = [];
        if (message.content) {
            msgContent.push({
                type: 'output_text',
                text: message.content,
                annotations: []
            });
        }

        output.push({
            type: 'message',
            id: msgId,
            status: 'completed',
            role: 'assistant',
            content: msgContent
        });
    }

    return output;
}

function buildUsage(chatResponse) {
    const usage = chatResponse.usage || {};
    return {
        input_tokens: usage.prompt_tokens || 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: usage.completion_tokens || 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: usage.total_tokens || 0
    };
}

export function *convertStreamToResponseEvents(chunkGenerator, rawRequest = {}) {
    const respId = `resp_${Date.now().toString(16)}${Math.random().toString(36).slice(2, 10)}`;
    const msgId = `msg_${Date.now().toString(16)}${Math.random().toString(36).slice(2, 10)}`;
    const now = Math.floor(Date.now() / 1000);
    const model = rawRequest.model || 'unknown';
    let seq = 0;

    const responseObject = {
        id: respId,
        object: 'response',
        created_at: now,
        status: 'in_progress',
        model,
        output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    };

    yield {
        type: 'response.created',
        response: responseObject,
        sequence_number: seq++
    };

    yield {
        type: 'response.in_progress',
        response: responseObject,
        sequence_number: seq++
    };

    yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
        sequence_number: seq++
    };

    yield {
        type: 'response.content_part.added',
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
        sequence_number: seq++
    };

    let fullText = '';
    let toolCallState = null;
    let lastUsage = null;

    for (const chunk of chunkGenerator) {
        if (chunk.usage) {
            lastUsage = chunk.usage;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
            fullText += delta.content;
            yield {
                type: 'response.output_text.delta',
                item_id: msgId,
                output_index: 0,
                content_index: 0,
                delta: delta.content,
                sequence_number: seq++,
                logprobs: []
            };
        }

        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                if (tc.id) {
                    toolCallState = {
                        id: `fc_${Date.now().toString(16)}${Math.random().toString(36).slice(2, 10)}`,
                        call_id: tc.id,
                        name: tc.function?.name || '',
                        arguments: ''
                    };
                    yield {
                        type: 'response.output_item.added',
                        output_index: 1,
                        item: {
                            type: 'function_call',
                            id: toolCallState.id,
                            call_id: toolCallState.call_id,
                            name: toolCallState.name,
                            arguments: '',
                            status: 'in_progress'
                        },
                        sequence_number: seq++
                    };
                }
                if (tc.function?.arguments && toolCallState) {
                    toolCallState.arguments += tc.function.arguments;
                    yield {
                        type: 'response.function_call_arguments.delta',
                        item_id: toolCallState.id,
                        output_index: 1,
                        call_id: toolCallState.call_id,
                        delta: tc.function.arguments,
                        sequence_number: seq++
                    };
                }
            }
        }

        if (choice.finish_reason) {
            break;
        }
    }

    if (fullText) {
        yield {
            type: 'response.output_text.done',
            item_id: msgId,
            output_index: 0,
            content_index: 0,
            text: fullText,
            sequence_number: seq++,
            logprobs: []
        };
    }

    yield {
        type: 'response.content_part.done',
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: fullText, annotations: [] },
        sequence_number: seq++
    };

    if (toolCallState) {
        yield {
            type: 'response.function_call_arguments.done',
            item_id: toolCallState.id,
            output_index: 1,
            call_id: toolCallState.call_id,
            arguments: toolCallState.arguments,
            sequence_number: seq++
        };
        yield {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
                type: 'function_call',
                id: toolCallState.id,
                call_id: toolCallState.call_id,
                name: toolCallState.name,
                arguments: toolCallState.arguments,
                status: 'completed'
            },
            sequence_number: seq++
        };
    }

    yield {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
            type: 'message',
            id: msgId,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: fullText, annotations: [] }]
        },
        sequence_number: seq++
    };

    const completedResponse = {
        id: respId,
        object: 'response',
        created_at: now,
        status: 'completed',
        completed_at: Math.floor(Date.now() / 1000),
        model,
        output: buildCompletedOutput(msgId, fullText, toolCallState),
        usage: buildCompletedUsage(lastUsage)
    };

    yield {
        type: 'response.completed',
        response: completedResponse,
        sequence_number: seq++
    };
}

function buildCompletedOutput(msgId, text, toolCallState) {
    const output = [];

    if (toolCallState) {
        output.push({
            type: 'function_call',
            id: toolCallState.id,
            call_id: toolCallState.call_id,
            name: toolCallState.name,
            arguments: toolCallState.arguments,
            status: 'completed'
        });
    }

    output.push({
        type: 'message',
        id: msgId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
    });

    return output;
}

function buildCompletedUsage(lastUsage) {
    return {
        input_tokens: lastUsage?.prompt_tokens || 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: lastUsage?.completion_tokens || 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: lastUsage?.total_tokens || 0
    };
}
