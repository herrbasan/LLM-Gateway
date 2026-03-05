/**
 * Image Fetcher Utility
 * Fetches remote images and converts them to base64 for vision APIs
 * Includes security validations
 */

export class ImageFetcher {
    constructor(config = {}) {
        this.config = {
            maxSize: config.maxSize || 20 * 1024 * 1024, // 20MB default
            timeout: config.timeout || 30000, // 30s default
            allowedProtocols: ['https:', 'http:'],
            blockedHosts: config.blockedHosts || [],
            ...config
        };
    }

    /**
     * Checks if a URL is a data URL (base64)
     */
    isDataUrl(url) {
        return url?.startsWith('data:');
    }

    /**
     * Parses a data URL and returns mime type and base64 data
     */
    parseDataUrl(url) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
            throw new Error('Invalid data URL format');
        }
        return {
            mimeType: match[1],
            base64: match[2]
        };
    }

    /**
     * Validates a remote URL for security
     */
    validateUrl(url) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (e) {
            throw new Error(`Invalid URL: ${url}`);
        }

        // Check protocol
        if (!this.config.allowedProtocols.includes(parsed.protocol)) {
            throw new Error(`Protocol not allowed: ${parsed.protocol}`);
        }

        // Check for private IP ranges
        const hostname = parsed.hostname;
        if (this.isPrivateIp(hostname)) {
            throw new Error('Private IP addresses not allowed');
        }

        // Check blocked hosts
        if (this.config.blockedHosts.some(host => hostname.includes(host))) {
            throw new Error('Host blocked');
        }

        return parsed;
    }

    /**
     * Checks if hostname is a private IP
     */
    isPrivateIp(hostname) {
        // Check for localhost
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return true;
        }

        // Check for private IP ranges
        const privateRanges = [
            /^10\./,                              // 10.0.0.0/8
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./,    // 172.16.0.0/12
            /^192\.168\./,                       // 192.168.0.0/16
            /^127\./,                             // 127.0.0.0/8
            /^169\.254\./,                       // Link-local
            /^0\./,                               // Current network
            /^::1$/,                              // IPv6 localhost
            /^fc00:/i,                            // IPv6 private
            /^fe80:/i                             // IPv6 link-local
        ];

        return privateRanges.some(range => range.test(hostname));
    }

    /**
     * Fetches an image from a remote URL
     */
    async fetchImage(url) {
        // If it's a data URL, parse it directly
        if (this.isDataUrl(url)) {
            return this.parseDataUrl(url);
        }

        // Validate the URL
        this.validateUrl(url);

        // Fetch with HEAD first to check size
        const headRes = await fetch(url, { method: 'HEAD' });
        if (!headRes.ok) {
            throw new Error(`Failed to fetch image: HTTP ${headRes.status}`);
        }

        const contentLength = headRes.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > this.config.maxSize) {
            throw new Error(`Image too large: ${contentLength} bytes (max: ${this.config.maxSize})`);
        }

        const contentType = headRes.headers.get('content-type');
        if (contentType && !contentType.startsWith('image/')) {
            throw new Error(`Invalid content type: ${contentType}`);
        }

        // Fetch the actual image
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        try {
            const res = await fetch(url, { 
                signal: controller.signal,
                headers: {
                    'Accept': 'image/*'
                }
            });
            clearTimeout(timeoutId);

            if (!res.ok) {
                throw new Error(`Failed to fetch image: HTTP ${res.status}`);
            }

            // Check size again
            const buffer = Buffer.from(await res.arrayBuffer());
            if (buffer.length > this.config.maxSize) {
                throw new Error(`Image too large: ${buffer.length} bytes`);
            }

            // Detect mime type from buffer if not provided
            const mimeType = contentType || this.detectMimeType(buffer);

            return {
                mimeType,
                base64: buffer.toString('base64'),
                size: buffer.length
            };
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                throw new Error('Image fetch timeout');
            }
            throw err;
        }
    }

    /**
     * Detects MIME type from buffer magic bytes
     */
    detectMimeType(buffer) {
        if (buffer.length < 4) return 'image/unknown';

        const magic = buffer.slice(0, 4).toString('hex');
        
        const signatures = {
            '89504e47': 'image/png',
            'ffd8ff': 'image/jpeg',
            '47494638': 'image/gif',
            '52494646': 'image/webp', // RIFF header for webp
            '424d': 'image/bmp'
        };

        for (const [sig, mime] of Object.entries(signatures)) {
            if (magic.startsWith(sig)) return mime;
        }

        return 'image/unknown';
    }
}

// Default instance
export const imageFetcher = new ImageFetcher();
