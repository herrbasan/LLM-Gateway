import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Centralized logging utility.
 * Creates a new timestamped log file on each gateway startup.
 * Also mirrors logs to console for development visibility.
 */
class Logger {
    constructor() {
        this.logFile = null;
        this.logStream = null;
        this.startTime = new Date();
        this.sessionId = this._generateSessionId();
        
        this._initializeLogFile();
    }
    
    _generateSessionId() {
        return `gw-${Date.now().toString(36).slice(-6)}`;
    }
    
    _initializeLogFile() {
        const logsDir = path.resolve(__dirname, '../../logs');
        
        // Ensure logs directory exists
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        
        // Create timestamped filename: YYYYMMDD-HHMMSS-sessionId.log
        const timestamp = this.startTime.toISOString()
            .replace(/[:T]/g, '-')
            .slice(0, 19);
        const filename = `${timestamp}-${this.sessionId}.log`;
        this.logFile = path.join(logsDir, filename);
        
        // Create write stream (append mode)
        this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
        
        // Write startup header
        this._writeToFile(`\n========================================`);
        this._writeToFile(`LLM Gateway Session: ${this.sessionId}`);
        this._writeToFile(`Started: ${this.startTime.toISOString()}`);
        this._writeToFile(`Log File: ${this.logFile}`);
        this._writeToFile(`========================================\n`);
        
        // Also log to console that we're logging
        console.log(`[Logger] Session ${this.sessionId} - Logging to: ${this.logFile}`);
    }
    
    _writeToFile(message) {
        if (this.logStream) {
            this.logStream.write(message + '\n');
        }
    }
    
    _formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const metaStr = Object.keys(meta).length > 0 
            ? ' ' + JSON.stringify(meta) 
            : '';
        return `[${timestamp}] [${level}] ${message}${metaStr}`;
    }
    
    /**
     * Log an info message
     */
    info(message, meta = {}) {
        const formatted = this._formatMessage('INFO', message, meta);
        this._writeToFile(formatted);
        console.log(`[INFO] ${message}`, meta);
    }
    
    /**
     * Log a warning message
     */
    warn(message, meta = {}) {
        const formatted = this._formatMessage('WARN', message, meta);
        this._writeToFile(formatted);
        console.warn(`[WARN] ${message}`, meta);
    }
    
    /**
     * Log an error message
     */
    error(message, error = null, meta = null) {
        const errorMeta = error ? { 
            error: error.message, 
            stack: error.stack,
            ...(meta || {}) 
        } : (meta || {});
        const formatted = this._formatMessage('ERROR', message, errorMeta);
        this._writeToFile(formatted);
        
        // Only log to console if there's something to show
        const hasError = error && error.message;
        const hasMeta = meta && Object.keys(meta).length > 0;
        if (hasError || hasMeta) {
            console.error(`[ERROR] ${message}`, error || '', meta || '');
        } else {
            console.error(`[ERROR] ${message}`);
        }
    }
    
    /**
     * Log a debug message
     */
    debug(message, meta = {}) {
        if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
            const formatted = this._formatMessage('DEBUG', message, meta);
            this._writeToFile(formatted);
            console.debug(`[DEBUG] ${message}`, meta);
        }
    }
    
    /**
     * Get current session info
     */
    getSessionInfo() {
        return {
            sessionId: this.sessionId,
            logFile: this.logFile,
            startedAt: this.startTime.toISOString()
        };
    }
    
    /**
     * Close the log stream gracefully
     */
    close() {
        if (this.logStream) {
            const duration = Date.now() - this.startTime.getTime();
            this._writeToFile(`\n[${new Date().toISOString()}] [INFO] Gateway shutting down. Session duration: ${Math.round(duration / 1000)}s`);
            this.logStream.end();
            this.logStream = null;
        }
    }
}

// Singleton instance
let loggerInstance = null;

export function createLogger() {
    if (!loggerInstance) {
        loggerInstance = new Logger();
    }
    return loggerInstance;
}

export function getLogger() {
    if (!loggerInstance) {
        return createLogger();
    }
    return loggerInstance;
}

// For testing: reset logger instance
export function resetLogger() {
    if (loggerInstance) {
        loggerInstance.close();
        loggerInstance = null;
    }
}
