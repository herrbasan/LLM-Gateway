# Logger Implementation Guide

> **Purpose**: Unified logging system with event typing for consistent log structure and filtering capabilities.

## Overview

This logger provides:
- **Timestamped log files** (one per gateway session)
- **Structured log format** with event types for filtering
- **Automatic log rotation** (configurable retention)
- **Multiple log levels** (INFO, WARN, ERROR, DEBUG)
- **JSON metadata support** for rich context

## Log Format

```
[2026-03-22T14:33:26.713Z] [INFO] [ModelRouter] Routing chat completion {"model":"kimi-chat"}
```

Structure:
```
[timestamp] [LEVEL] [TYPE] message {optional JSON metadata}
```

## Implementation

### 1. Logger Class (`src/utils/logger.js`)

```javascript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_LOG_RETENTION_DAYS = 1;

class Logger {
    constructor() {
        this.logFile = null;
        this.logStream = null;
        this.startTime = new Date();
        this.sessionId = this._generateSessionId();
        this.logRetentionDays = this._resolveLogRetentionDays();
        
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

        this._pruneOldLogs(logsDir);
        
        // Create timestamped filename: YYYY-MM-DD-HH-MM-SS-sessionId.log
        const timestamp = this.startTime.toISOString()
            .replace(/[:T]/g, '-')
            .slice(0, 19);
        const filename = `${timestamp}-${this.sessionId}.log`;
        this.logFile = path.join(logsDir, filename);
        
        // Create write stream (append mode)
        this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
        
        // Write startup header
        this._writeToFile(`\n========================================`);
        this._writeToFile(`Gateway Session: ${this.sessionId}`);
        this._writeToFile(`Started: ${this.startTime.toISOString()}`);
        this._writeToFile(`Log File: ${this.logFile}`);
        this._writeToFile(`Retention Days: ${this.logRetentionDays}`);
        this._writeToFile(`========================================\n`);
    }

    _resolveLogRetentionDays() {
        const rawValue = process.env.LOG_RETENTION_DAYS;
        if (rawValue == null || rawValue === '') {
            return DEFAULT_LOG_RETENTION_DAYS;
        }
        const parsed = Number(rawValue);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LOG_RETENTION_DAYS;
    }

    _pruneOldLogs(logsDir) {
        if (this.logRetentionDays <= 0) return;

        const cutoffMs = this.startTime.getTime() - (this.logRetentionDays * 24 * 60 * 60 * 1000);

        try {
            const entries = fs.readdirSync(logsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.log')) continue;

                const filePath = path.join(logsDir, entry.name);
                const stats = fs.statSync(filePath);
                if (stats.mtimeMs < cutoffMs) {
                    fs.unlinkSync(filePath);
                }
            }
        } catch (error) {
            // Log retention failures should not stop the app
            console.error('Failed to prune old logs:', error.message);
        }
    }
    
    _writeToFile(message) {
        if (this.logStream) {
            this.logStream.write(message + '\n');
        }
    }
    
    /**
     * Format a log message
     * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG)
     * @param {string} type - Event type/category (e.g., 'System', 'ModelRouter', 'WebSocket')
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata (serialized as JSON)
     */
    _formatMessage(level, type, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const metaStr = Object.keys(meta).length > 0 
            ? ' ' + JSON.stringify(meta) 
            : '';
        return `[${timestamp}] [${level}] [${type}] ${message}${metaStr}`;
    }
    
    /**
     * Log an info message
     * @param {string} message - Log message
     * @param {object} meta - Metadata object
     * @param {string} type - Event type/category (default: 'System')
     */
    info(message, meta = {}, type = 'System') {
        const formatted = this._formatMessage('INFO', type, message, meta);
        this._writeToFile(formatted);
    }
    
    /**
     * Log a warning message
     * @param {string} message - Log message
     * @param {object} meta - Metadata object
     * @param {string} type - Event type/category (default: 'System')
     */
    warn(message, meta = {}, type = 'System') {
        const formatted = this._formatMessage('WARN', type, message, meta);
        this._writeToFile(formatted);
    }
    
    /**
     * Log an error message
     * @param {string} message - Log message
     * @param {Error|null} error - Error object (optional)
     * @param {object|null} meta - Additional metadata
     * @param {string} type - Event type/category (default: 'System')
     */
    error(message, error = null, meta = null, type = 'System') {
        const errorMeta = error ? { 
            error: error.message, 
            stack: error.stack,
            ...(meta || {}) 
        } : (meta || {});
        const formatted = this._formatMessage('ERROR', type, message, errorMeta);
        this._writeToFile(formatted);
    }
    
    /**
     * Log a debug message (only in development/DEBUG mode)
     * @param {string} message - Log message
     * @param {object} meta - Metadata object
     * @param {string} type - Event type/category (default: 'System')
     */
    debug(message, meta = {}, type = 'System') {
        if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
            const formatted = this._formatMessage('DEBUG', type, message, meta);
            this._writeToFile(formatted);
        }
    }
    
    /**
     * Get current session info
     * @returns {object} Session info with sessionId, logFile, startedAt
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
            this._writeToFile(`\n[${new Date().toISOString()}] [INFO] [System] Gateway shutting down. Session duration: ${Math.round(duration / 1000)}s`);
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
```

### 2. Usage Patterns

#### Basic Logging (defaults to 'System' type)
```javascript
import { getLogger } from './utils/logger.js';

const logger = getLogger();

logger.info('Server starting', { port: 3000 });
logger.warn('Configuration missing', { key: 'API_KEY' });
logger.error('Database connection failed', error);
logger.debug('Processing request', { id: 123 });
```

#### Typed Logging (recommended for modules)
```javascript
// In ModelRouter.js
logger.info('Routing chat completion', { model: 'gpt-4' }, 'ModelRouter');

// In WebSocket handlers
logger.info('Connection opened', { id: connId }, 'WebSocket');

// In Chat handlers  
logger.warn('Request cancelled', { id: reqId }, 'ChatHandler');
```

#### Error Logging with Full Context
```javascript
// With Error object
try {
    await riskyOperation();
} catch (err) {
    logger.error('Operation failed', err, { operation: 'risky' }, 'MyModule');
}

// Without Error object, just metadata
logger.error('Validation failed', null, { field: 'email', value: 'invalid' }, 'Validation');
```

### 3. Event Type Conventions

Choose consistent type names for your modules:

| Type | Purpose |
|------|---------|
| `System` | Application lifecycle, startup/shutdown |
| `Server` | HTTP server errors, request handling |
| `Config` | Configuration loading, updates |
| `{Module}Router` | Request routing logic |
| `{Adapter}` | External API adapters (e.g., `OpenAIAdapter`, `KimiAdapter`) |
| `{Feature}Handler` | Feature-specific handlers (e.g., `ChatHandler`, `AudioHandler`) |
| `WebSocket` | WebSocket connection management |
| `Database` | Database operations |
| `Auth` | Authentication/authorization events |
| `MediaProcessor` | Image/audio processing |

**Naming rules:**
- Use PascalCase
- Be specific to the module/component
- Keep it consistent across the codebase

### 4. Environment Configuration

```bash
# .env file

# Log retention in days (default: 1)
LOG_RETENTION_DAYS=7

# Enable debug logging
DEBUG=true
# or
NODE_ENV=development
```

### 5. Log File Structure

```
logs/
├── 2026-03-22-08-57-55-gw-1ixp0h.log   # Current session
├── 2026-03-22-07-59-55-gw-1gv45y.log   # Previous session
└── ...
```

File naming: `YYYY-MM-DD-HH-MM-SS-gw-<sessionId>.log`

### 6. Integration with Log Viewer API

If implementing a `/logs` endpoint for log viewing:

```javascript
// Parsing regex for the log format
const LOG_LINE_REGEX = /^\[([^\]]+)\] \[(\w+)\] \[([^\]]+)\] (.+)$/;

// Parse log line
function parseLogLine(line) {
    const match = line.match(LOG_LINE_REGEX);
    if (!match) return null;
    
    const [, timestamp, level, type, rest] = match;
    
    // Extract message and payload
    let message = rest;
    let payload = null;
    
    const lastBraceIndex = rest.lastIndexOf(' {');
    if (lastBraceIndex !== -1) {
        const potentialJson = rest.slice(lastBraceIndex + 1);
        try {
            payload = JSON.parse(potentialJson);
            message = rest.slice(0, lastBraceIndex);
        } catch {
            // Keep original if JSON parse fails
        }
    }
    
    return { timestamp, level, type, message, payload };
}
```

## Migration Guide

### From Simple Logging

**Before:**
```javascript
console.log('Server started on port 3000');
```

**After:**
```javascript
logger.info('Server started', { port: 3000 }, 'System');
```

### From Message-Prefixed Logging

**Before:**
```javascript
logger.info('[ModelRouter] Routing chat completion');
```

**After:**
```javascript
logger.info('Routing chat completion', {}, 'ModelRouter');
```

### From Error-Only Logging

**Before:**
```javascript
logger.error('Database error: ' + err.message);
```

**After:**
```javascript
logger.error('Database connection failed', err, { service: 'postgres' }, 'Database');
```

## Testing

```javascript
import { expect } from 'chai';
import { getLogger, resetLogger } from './utils/logger.js';

describe('Logger', () => {
    let logger;

    beforeEach(() => {
        resetLogger();
        logger = getLogger();
    });

    afterEach(() => {
        resetLogger();
    });

    it('should log with default System type', () => {
        logger.info('Test message');
        // Verify log file contains: [INFO] [System] Test message
    });

    it('should log with custom type', () => {
        logger.info('Custom message', {}, 'CustomModule');
        // Verify log file contains: [INFO] [CustomModule] Custom message
    });
});
```

## Best Practices

1. **Always use typed logging** for module-specific logs
2. **Include relevant metadata** for debugging (IDs, counts, sizes)
3. **Use appropriate log levels:**
   - `INFO`: Normal operations, lifecycle events
   - `WARN`: Recoverable issues, deprecated usage
   - `ERROR`: Failures that need attention
   - `DEBUG`: Detailed tracing (development only)
4. **Don't log sensitive data** (passwords, API keys, tokens)
5. **Keep messages concise** - put details in metadata
6. **Be consistent** with type names across the codebase

## Benefits

- **Structured querying**: Filter logs by type, level, session
- **Module scoping**: Quickly identify which component logged what
- **Better debugging**: Rich metadata context for each log entry
- **Log viewer integration**: Consistent format for UI display
- **Operational insight**: Track system health by module
