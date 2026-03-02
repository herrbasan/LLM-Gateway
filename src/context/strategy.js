export class ContextManager {
    constructor(config) {
        this.config = config.compaction || {};
    }

    /**
     * Truncates older messages to fit the context window.
     * Preserves system prompt and last N exchanges (configured via `preserveLastN`).
     * Fallback matrix:
     * 1. Reduce N until it fits
     * 2. If N=1 still doesn't fit, truncate the oldest user message string content
     * 3. If system prompt + max 1 empty message > context: throws Error
     * 
     * @param {Array} messages - The array of message objects.
     * @param {number} availableTokens - Max tokens available.
     * @param {Object} estimator - Token estimator instance.
     * @param {Object} adapter - The adapter to use for estimating tokens.
     */
    async truncate(messages, availableTokens, estimator, adapter, strategyConfig = {}, onProgress = null) {
        const config = { ...this.config, ...strategyConfig };
        let systemPromptMsg = null;
        let otherMessages = [];

        // Separate system prompt if we want to preserve it
        if (config.preserveSystemPrompt && messages.length > 0 && messages[0].role === 'system') {
            systemPromptMsg = messages[0];
            otherMessages = messages.slice(1);
        } else {
            otherMessages = [...messages];
        }

        let systemTokens = systemPromptMsg ? await estimator.estimate(systemPromptMsg.content, adapter) : 0;
        
        if (systemTokens > availableTokens) {
            throw new Error(`[Context Strategy] 413 Payload Too Large: System prompt alone exceeds available tokens (${systemTokens} > ${availableTokens}).`);
        }

        let targetTokensForMessages = availableTokens - systemTokens;
        
        // Preserve last N exchanges (each exchange is typically User + Assistant, but we just keep N messages)
        let nToKeep = config.preserveLastN ?? 4;
        nToKeep = Math.min(nToKeep, otherMessages.length);
        
        let keptMessages = [];
        let numTokens = 0;

        // Start by trying to pack from the end
        while (nToKeep >= 1) {
            keptMessages = otherMessages.slice(-nToKeep);
            const contentString = keptMessages.map(m => m.content).join('');
            numTokens = await estimator.estimate(contentString, adapter);

            if (numTokens <= targetTokensForMessages) {
                break; // Fits!
            }
            nToKeep--; // Reduce N
        }

        // If N=1 still doesn't fit, truncate text content of that last message
        if (nToKeep === 0 && otherMessages.length > 0) {
            const lastMsg = otherMessages[otherMessages.length - 1];
            // Brute force character cut to fit heuristically
            // Estimate tokens again, slice char array
            const charLimit = Math.floor(targetTokensForMessages / estimator.fallbackRatio); // rough
            let truncatedContent = lastMsg.content;
            if (truncatedContent.length > charLimit) {
                truncatedContent = truncatedContent.substring(0, charLimit - 50) + '... [truncated]';
            }
            
            // Re-check
            const finalTokens = await estimator.estimate(truncatedContent, adapter);
            if (finalTokens > targetTokensForMessages) {
                // If it STILL doesn't fit, extreme cut
                truncatedContent = truncatedContent.substring(0, Math.floor(charLimit / 2)) + '... [truncated]';
            }

            keptMessages = [{ ...lastMsg, content: truncatedContent }];
        }

        const finalMessages = [];
        if (systemPromptMsg) {
            finalMessages.push(systemPromptMsg);
        }
        finalMessages.push(...keptMessages);

        return finalMessages;
    }

    /**
     * Applies Single-pass Summarization to compress all non-system history into one message
     */
    async compress(messages, availableTokens, estimator, adapter, strategyConfig = {}, onProgress = null) {
        const config = { ...this.config, ...strategyConfig };
        // Find messages to compress (exclude system and maybe keep very last user query)
        const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
        let msgsToCompress = systemMsg ? messages.slice(1) : messages;
        
        // It's usually best to keep the last user message intact and compress the rest
        let lastUserMsg = null;
        if (msgsToCompress.length > 0 && msgsToCompress[msgsToCompress.length - 1].role === 'user') {
            lastUserMsg = msgsToCompress.pop();
        }

        if (msgsToCompress.length === 0) {
            return msgsToCompress; // Nothing to compress
        }

        const combinedText = msgsToCompress.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

        const prompt = `Please summarize the following conversation history concisely, retaining all key facts and context relevant to continuing the conversation:\n\n${combinedText}`;

        // Wait to use the adapter to summarize
        const summaryOpts = {
            prompt,
            systemPrompt: "You are a highly efficient assistant summarizing conversation history.",
            maxTokens: Math.floor(availableTokens * (config.targetRatio || 0.3)),
            temperature: 0.1
        };

        const response = await adapter.predict(summaryOpts);
        const summaryText = typeof response === 'string' ? response : (response.choices?.[0]?.message?.content || response);

        const newMessages = [];
        if (systemMsg) newMessages.push(systemMsg);
        
        newMessages.push({
            role: 'assistant',
            content: `[Conversation history summarized to save context window]:\n${summaryText}`
        });

        if (lastUserMsg) newMessages.push(lastUserMsg);

        return newMessages;
    }

    /**
     * Applies Rolling Compression across chunks
     */
    async rolling(messages, availableTokens, estimator, adapter, strategyConfig = {}, onProgress = null) {
        const config = { ...this.config, ...strategyConfig };
        // Implement chained summaries. For now it aggregates chunks.
        const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
        let msgsToCompress = systemMsg ? messages.slice(1) : messages;
        let lastUserMsg = null;

        if (msgsToCompress.length > 0 && msgsToCompress[msgsToCompress.length - 1].role === 'user') {
            lastUserMsg = msgsToCompress.pop();
        }

        const combinedText = msgsToCompress.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
        
        const chunkSizeChars = (config.chunkSize || 3000) * 3; 
        const chunks = [];
        for (let i = 0; i < combinedText.length; i += chunkSizeChars) {
            chunks.push(combinedText.substring(i, i + chunkSizeChars));
        }

        let previousSummary = "";
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
            const chunk = chunks[chunkIndex];
            if (onProgress) {
                onProgress({ type: 'compaction.progress', data: { chunk: chunkIndex + 1, total: chunks.length } });
            }

            const prompt = previousSummary 
                ? `Previous Summary: ${previousSummary}\n\n---NEW CONTENT---\n\n${chunk}\n\nPlease update the summary incorporating the new content.`
                : `Please summarize the following content:\n\n${chunk}`;

            const summaryOpts = {
                prompt,
                systemPrompt: "You are an assistant summarizing long documents incrementally.",
                maxTokens: Math.floor(availableTokens * (config.targetRatio || 0.3)),
                temperature: 0.1
            };

            const response = await adapter.predict(summaryOpts);
            previousSummary = typeof response === 'string' ? response : (response.choices?.[0]?.message?.content || response);
        }

        const newMessages = [];
        if (systemMsg) newMessages.push(systemMsg);
        if (previousSummary) {
            newMessages.push({
                role: 'assistant',
                content: `[Conversation history summarized incrementally]:\n${previousSummary}`
            });
        }
        if (lastUserMsg) newMessages.push(lastUserMsg);

        return newMessages;
    }
}
