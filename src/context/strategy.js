import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export class ContextManager {
    constructor(config) {
        this.config = config.compaction || {};
    }

    /**
     * Helper to safely extract text from mixed-content (vision) messages,
     * replacing images with a placeholder to preserve text flow.
     */
    _stringifyMessageContent(content) {
        if (Array.isArray(content)) {
            return content.map(part => {
                if (part.type === 'image_url') {
                    return '[System Placeholder: Image Omitted]';
                }
                return part.text || '';
            }).join('\n');
        }
        return String(content || '');
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
        logger.info(`Truncate: starting with ${messages.length} messages, available=${availableTokens}`, null, 'ContextStrategy');
        
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
        
        // Preserve last N messages (these are most recent/relevant)
        let nToKeep = config.preserveLastN ?? 4;
        nToKeep = Math.min(nToKeep, otherMessages.length);
        
        let keptMessages = [];
        let numTokens = 0;

        // Start by trying to pack from the end (most recent)
        while (nToKeep >= 1) {
            keptMessages = otherMessages.slice(-nToKeep);
            
            numTokens = 0;
            for (const m of keptMessages) {
                numTokens += await estimator.estimate(m.content, adapter, null);
            }

            if (numTokens <= targetTokensForMessages) {
                logger.info(`Truncate: keeping last ${nToKeep} messages, tokens=${numTokens}`, null, 'ContextStrategy');
                break; // Fits!
            }
            // If it doesn't fit, we drop the oldest by reducing nToKeep.
            // But wait, if we are dropping messages containing images, we might want to just strip the images first before dropping the WHOLE message?
            // "strip `image_url` objects from older context messages and replace them with a `[System Placeholder: Image Omitted]` tag"
            // For now, let's stick to the sliding window reduction.
            nToKeep--; // Reduce N
        }

        // If even 1 message doesn't fit, truncate its content
        if (nToKeep === 0 && otherMessages.length > 0) {
            const lastMsg = otherMessages[otherMessages.length - 1];
            // Rough char to token conversion for truncation
            const charLimit = Math.floor(targetTokensForMessages / 0.25);
            let truncatedContent = this._stringifyMessageContent(lastMsg.content);
            if (truncatedContent.length > charLimit) {
                truncatedContent = truncatedContent.substring(0, charLimit - 50) + '... [truncated]';
            }
            
            // Re-check
            const finalTokens = await estimator.estimate(truncatedContent, adapter);
            if (finalTokens > targetTokensForMessages) {
                // Extreme cut
                truncatedContent = truncatedContent.substring(0, Math.floor(charLimit / 2)) + '... [truncated]';
            }

            keptMessages = [{ ...lastMsg, content: truncatedContent }];
            logger.info('Truncate: truncated single message to fit', null, 'ContextStrategy');
        }

        const finalMessages = [];
        if (systemPromptMsg) finalMessages.push(systemPromptMsg);
        finalMessages.push(...keptMessages);

        logger.info(`Truncate: returning ${finalMessages.length} messages`, null, 'ContextStrategy');
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

        const combinedText = msgsToCompress.map(m => `${m.role.toUpperCase()}: ${this._stringifyMessageContent(m.content)}`).join('\n\n');

        // Use configurable prompts with fallbacks
        const promptTemplates = config.prompts?.compress || {};
        const userTemplate = promptTemplates.user || "Please summarize the following conversation history concisely, retaining all key facts and context relevant to continuing the conversation:\n\n{content}";
        const systemPrompt = promptTemplates.system || "You are a highly efficient assistant summarizing conversation history.";
        
        const prompt = userTemplate.replace('{content}', combinedText);

        const summaryOpts = {
            prompt,
            systemPrompt,
            maxTokens: Math.floor(availableTokens * (config.targetRatio || 0.3)),
            temperature: 0.1
        };

        const response = await adapter.predict(summaryOpts);
        const summaryText = typeof response === 'string' ? response : (response.choices?.[0]?.message?.content || response);

        const newMessages = [];
        if (systemMsg) newMessages.push(systemMsg);
        
        const summaryPrefix = config.prompts?.compress?.summaryPrefix || "[Conversation history summarized to save context window]:";
        newMessages.push({
            role: 'assistant',
            content: `${summaryPrefix}\n${summaryText}`
        });

        if (lastUserMsg) newMessages.push(lastUserMsg);

        return newMessages;
    }

    /**
     * Applies Rolling Compression across chunks
     */
    async rolling(messages, availableTokens, estimator, adapter, strategyConfig = {}, onProgress = null) {
        const config = { ...this.config, ...strategyConfig };
        logger.info(`Rolling: starting with ${messages.length} messages, available=${availableTokens}`, null, 'ContextStrategy');
        
        // Implement chained summaries
        const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
        let msgsToCompress = systemMsg ? messages.slice(1) : [...messages];
        let lastUserMsg = null;

        // Pop last user message to preserve it, UNLESS it's the ONLY message
        if (msgsToCompress.length > 1 && msgsToCompress[msgsToCompress.length - 1].role === 'user') {
            lastUserMsg = msgsToCompress.pop();
            logger.info(`Rolling: preserving last user message, compressing ${msgsToCompress.length} messages`, null, 'ContextStrategy');
        }

        const combinedText = msgsToCompress.map(m => `${m.role.toUpperCase()}: ${this._stringifyMessageContent(m.content)}`).join('\n\n');
        logger.info(`Rolling: combined text length: ${combinedText.length} chars`, null, 'ContextStrategy');
        
        // Calculate dynamic chunk size based on available context
        // We need to fit: previous_summary + chunk + prompt overhead within available tokens
        const summaryReserve = 2000; // Reserve space for summary (grows with each chunk)
        const promptOverhead = 500;  // "Previous Summary: ... Please update..." text
        const charsPerToken = 4;     // Rough estimate
        
        // Chunk should be: (available - reserve - overhead) * chars_per_token
        const chunkTokens = Math.max(1000, availableTokens - summaryReserve - promptOverhead);
        const chunkSizeChars = Math.floor(chunkTokens * charsPerToken * 0.8); // 80% safety margin
        
        logger.info(`Rolling: dynamic chunk size: ${chunkSizeChars} chars (~${chunkTokens} tokens)`, null, 'ContextStrategy');
        
        const chunks = [];
        for (let i = 0; i < combinedText.length; i += chunkSizeChars) {
            chunks.push(combinedText.substring(i, i + chunkSizeChars));
        }
        logger.info(`Rolling: split into ${chunks.length} chunks`, null, 'ContextStrategy');

        // If too many chunks, fall back to truncate
        const maxChunks = 20;
        if (chunks.length > maxChunks) {
            logger.info(`Rolling: too many chunks (${chunks.length} > ${maxChunks}), falling back to truncate`, null, 'ContextStrategy');
            return this.truncate(messages, availableTokens, estimator, adapter, strategyConfig, onProgress);
        }

        let previousSummary = "";
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
            const chunk = chunks[chunkIndex];
            if (onProgress) {
                onProgress({ type: 'compaction.progress', data: { chunk: chunkIndex + 1, total: chunks.length } });
            }

            // Use configurable prompts with fallbacks
            const rollingTemplates = config.prompts?.rolling || {};
            const systemPrompt = rollingTemplates.system || "You are an assistant summarizing long documents incrementally. Keep it concise.";
            const initialTemplate = rollingTemplates.initial || "Please summarize the following content:\n\n{chunk}";
            const updateTemplate = rollingTemplates.update || "Previous Summary: {summary}\n\n---NEW CONTENT---\n\n{chunk}\n\nPlease update the summary incorporating the new content.";
            
            const prompt = previousSummary 
                ? updateTemplate.replace('{summary}', previousSummary).replace('{chunk}', chunk)
                : initialTemplate.replace('{chunk}', chunk);

            const summaryOpts = {
                prompt,
                systemPrompt,
                maxTokens: Math.min(1000, Math.floor(availableTokens * 0.1)),
                temperature: 0.1
            };

            try {
                logger.info(`Rolling: summarizing chunk ${chunkIndex + 1}/${chunks.length}, prompt length=${prompt.length}`, null, 'ContextStrategy');
                const response = await adapter.predict(summaryOpts);
                previousSummary = typeof response === 'string' ? response : (response.choices?.[0]?.message?.content || response);
                logger.info(`Rolling: chunk ${chunkIndex + 1} summary length: ${previousSummary.length}`, null, 'ContextStrategy');
            } catch (err) {
                logger.error(`Rolling: failed to summarize chunk ${chunkIndex + 1}: ${err.message}`, null, 'ContextStrategy');
                logger.info('Rolling: falling back to truncate due to error', null, 'ContextStrategy');
                return this.truncate(messages, availableTokens, estimator, adapter, strategyConfig, onProgress);
            }
        }

        const newMessages = [];
        if (systemMsg) newMessages.push(systemMsg);
        if (previousSummary) {
            const summaryPrefix = config.prompts?.rolling?.summaryPrefix || "[Conversation history summarized incrementally]:";
            newMessages.push({
                role: 'assistant',
                content: `${summaryPrefix}\n${previousSummary}`
            });
        }
        if (lastUserMsg) newMessages.push(lastUserMsg);

        logger.info(`Rolling: complete: ${newMessages.length} messages`, null, 'ContextStrategy');
        return newMessages;
    }
}
