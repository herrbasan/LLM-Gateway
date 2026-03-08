import { request } from './http.js';

/**
 * Provider-specific vision limits
 * These define max dimensions and recommended sizes for each provider
 */
export const PROVIDER_VISION_LIMITS = {
    // OpenAI: https://platform.openai.com/docs/guides/vision
    // - Low detail: 512x512
    // - High detail: 2048x2048 max, then scales to 768x768
    openai: {
        maxDimension: 2048,
        lowResSize: 512,
        highResSize: 2048,
        autoResSize: 1024,
        maxFileSize: 20 * 1024 * 1024, // 20MB
        supportedFormats: ['png', 'jpeg', 'gif', 'webp'],
        description: 'OpenAI GPT-4o/GPT-4-turbo'
    },
    
    // Gemini: https://ai.google.dev/gemini-api/docs/vision
    // - Supports up to 3072x3072
    // - No specific dimension constraints mentioned beyond file size
    gemini: {
        maxDimension: 3072,
        lowResSize: 512,
        highResSize: 2048,
        autoResSize: 1024,
        maxFileSize: 20 * 1024 * 1024, // 20MB (compressed)
        supportedFormats: ['png', 'jpeg', 'gif', 'webp', 'heic', 'heif'],
        description: 'Google Gemini'
    },
    
    // Grok (xAI): Uses OpenAI-compatible format
    // Assuming similar limits to OpenAI
    grok: {
        maxDimension: 2048,
        lowResSize: 512,
        highResSize: 2048,
        autoResSize: 1024,
        maxFileSize: 20 * 1024 * 1024,
        supportedFormats: ['png', 'jpeg', 'gif', 'webp'],
        description: 'xAI Grok'
    },
    
    // LM Studio: Local deployment, varies by model
    // Using conservative defaults
    lmstudio: {
        maxDimension: 2048,
        lowResSize: 512,
        highResSize: 1024,
        autoResSize: 768,
        maxFileSize: 50 * 1024 * 1024, // Larger for local processing
        supportedFormats: ['png', 'jpeg', 'gif', 'webp'],
        description: 'LM Studio (local)'
    },
    
    // Ollama: Local deployment, varies by model
    ollama: {
        maxDimension: 2048,
        lowResSize: 512,
        highResSize: 1024,
        autoResSize: 768,
        maxFileSize: 50 * 1024 * 1024,
        supportedFormats: ['png', 'jpeg', 'gif', 'webp'],
        description: 'Ollama (local)'
    },
    
    // Default fallback for unknown providers
    default: {
        maxDimension: 2048,
        lowResSize: 512,
        highResSize: 1536,
        autoResSize: 1024,
        maxFileSize: 20 * 1024 * 1024,
        supportedFormats: ['png', 'jpeg', 'gif', 'webp'],
        description: 'Default'
    }
};

/**
 * Client for communicating with the external Media Processing Node.
 * This handles offloading heavy image resizing and video manipulations
 * so we don't bloat the Gateway's main unmanaged V8 heap.
 */
export class MediaProcessorClient {
    constructor(config) {
        this.config = config.mediaProcessor || { enabled: false };
        this.providerLimits = { ...PROVIDER_VISION_LIMITS, ...(config.providerVisionLimits || {}) };
    }

    get isEnabled() {
        return this.config.enabled && !!this.config.endpoint;
    }

    /**
     * Get vision limits for a specific provider
     * @param {string} provider - Provider name (e.g., 'openai', 'gemini', 'grok')
     * @returns {Object} Provider limits
     */
    getProviderLimits(provider = 'default') {
        const providerLower = provider?.toLowerCase() || 'default';
        return this.providerLimits[providerLower] || this.providerLimits.default;
    }

    /**
     * Validate image dimensions against provider limits
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {string} provider - Provider name
     * @returns {Object} Validation result { valid: boolean, maxDimension: number }
     */
    validateDimensions(width, height, provider = 'default') {
        const limits = this.getProviderLimits(provider);
        const maxDim = Math.max(width, height);
        
        return {
            valid: maxDim <= limits.maxDimension,
            maxDimension: limits.maxDimension,
            currentDimension: maxDim,
            needsResize: maxDim > limits.maxDimension
        };
    }

    /**
     * Get max dimension for detail level and provider
     * @param {string} detail - Detail level: 'low', 'high', or 'auto'
     * @param {string} provider - Provider name
     * @returns {number} Max dimension in pixels
     */
    getMaxDimensionForDetail(detail = 'auto', provider = 'default') {
        const limits = this.getProviderLimits(provider);
        
        switch (detail) {
            case 'low':
                return limits.lowResSize;
            case 'high':
                return limits.highResSize;
            case 'auto':
            default:
                return limits.autoResSize;
        }
    }

    /**
     * Check if image format is supported by provider
     * @param {string} mimeType - MIME type (e.g., 'image/png')
     * @param {string} provider - Provider name
     * @returns {boolean} Whether format is supported
     */
    isFormatSupported(mimeType, provider = 'default') {
        const limits = this.getProviderLimits(provider);
        const format = mimeType?.replace('image/', '').toLowerCase();
        return limits.supportedFormats.includes(format);
    }

    /**
     * Process image with explicit options (resize, transcode, quality).
     * @param {string} base64Data - The original image base64 data.
     * @param {string} mimeType - The mime type of the image.
     * @param {Object} options - Processing options.
     * @param {number} [options.maxDimension] - Max width/height in pixels (null = no resize).
     * @param {string} [options.format] - Output format: 'jpeg', 'png', 'webp' (null = keep original).
     * @param {number} [options.quality] - Quality 1-100 for lossy formats (default: 85).
     * @returns {Promise<string>} The processed base64 string.
     */
    async processImage(base64Data, mimeType, options = {}) {
        if (!this.isEnabled) {
            return base64Data; // Bypass if not configured
        }

        const { maxDimension, format, quality = 85 } = options;

        console.log(`[MediaProcessor] Processing: maxDimension=${maxDimension}, format=${format}, quality=${quality}`);

        const endpoint = `${this.config.endpoint}/v1/optimize/image`;
        try {
            const body = {
                base64: base64Data,
                quality,
                response_type: 'base64'
            };

            // Only include max_dimension if explicitly set
            if (maxDimension) {
                body.max_dimension = maxDimension;
            }

            // Only include format if explicitly set
            if (format) {
                body.format = format;
            }

            const res = await request(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            
            if (!res.ok) {
                console.warn(`[MediaProcessor] Failed to process image. Status: ${res.status}`);
                return base64Data; // fallback to original
            }

            const data = await res.json();
            if (data.base64) {
                 return data.base64.replace(/^data:[^;]+;base64,/, '');
            }
            return base64Data;
            
        } catch (error) {
            console.error(`[MediaProcessor] Error communicating with media-processor node:`, error.message);
            return base64Data; // Fail gracefully by returning original
        }
    }

    /**
     * Legacy method for backward compatibility.
     * @deprecated Use processImage() instead.
     */
    async optimizeImage(base64Data, mimeType, detail = 'auto', provider = 'default', explicitMaxDimension = null) {
        const maxDimension = explicitMaxDimension || this.getMaxDimensionForDetail(detail, provider);
        return this.processImage(base64Data, mimeType, {
            maxDimension,
            format: 'jpeg',
            quality: detail === 'low' ? 70 : 85
        });
    }

    /**
     * Get information about provider vision limits
     * @param {string} provider - Provider name (optional, returns all if not specified)
     * @returns {Object} Provider limits info
     */
    getLimitsInfo(provider = null) {
        if (provider) {
            return this.getProviderLimits(provider);
        }
        return this.providerLimits;
    }
}
