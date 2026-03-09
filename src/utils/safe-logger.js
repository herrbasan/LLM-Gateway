/**
 * Safe logging utilities that prevent binary data from being logged.
 * Base64 images/audio can be 10MB+ and should never hit the logs.
 */

/**
 * Check if a value looks like base64 binary data (long alphanumeric string)
 * @param {*} value 
 * @returns {boolean}
 */
function looksLikeBase64(value) {
    if (typeof value !== 'string') return false;
    // Base64 strings are typically long (>100 chars) and contain only base64 chars
    if (value.length < 100) return false;
    // Quick check: if it's longer than 500 chars and mostly alphanumeric with +/=, it's likely base64
    const base64Pattern = /^[A-Za-z0-9+/=]+$/;
    return base64Pattern.test(value) && value.length > 500;
}

/**
 * Sanitize an object by replacing binary/base64 fields with placeholders
 * @param {*} obj 
 * @param {string} [placeholder] 
 * @returns {*}
 */
export function sanitizeForLogging(obj, placeholder = '[BINARY_DATA]') {
    if (obj === null || obj === undefined) return obj;
    
    // Handle primitive types
    if (typeof obj !== 'object') {
        // If it's a string that looks like base64, truncate it
        if (typeof obj === 'string') {
            if (looksLikeBase64(obj)) {
                return `${placeholder}(${obj.length} chars)`;
            }
            // Truncate long strings even if not base64
            if (obj.length > 500) {
                return obj.substring(0, 200) + `... [${obj.length} chars total]`;
            }
        }
        return obj;
    }
    
    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeForLogging(item, placeholder));
    }
    
    // Handle objects
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        // Known binary field names - always sanitize these
        const binaryFields = ['b64_json', 'base64', 'bytesBase64Encoded', 'inlineData', 'data', 'buffer', 'blob'];
        if (binaryFields.includes(key) && typeof value === 'string' && value.length > 100) {
            sanitized[key] = `${placeholder}(${value.length} chars)`;
        } else {
            sanitized[key] = sanitizeForLogging(value, placeholder);
        }
    }
    return sanitized;
}

/**
 * Create a safe console logger that auto-sanitizes
 * @param {string} prefix 
 */
export function createSafeLogger(prefix) {
    return {
        log: (...args) => console.log(prefix, ...args.map(a => sanitizeForLogging(a))),
        error: (...args) => console.error(prefix, ...args.map(a => sanitizeForLogging(a))),
        warn: (...args) => console.warn(prefix, ...args.map(a => sanitizeForLogging(a))),
        info: (...args) => console.info(prefix, ...args.map(a => sanitizeForLogging(a))),
        debug: (...args) => console.debug(prefix, ...args.map(a => sanitizeForLogging(a)))
    };
}

/**
 * Safely log an error without including binary data from the response
 * @param {Error} error 
 * @param {Object} context 
 */
export function logErrorSafe(error, context = {}) {
    const safeContext = sanitizeForLogging(context);
    console.error('[ERROR]', error.message, {
        stack: error.stack,
        status: error.status,
        code: error.code,
        ...safeContext
    });
}
