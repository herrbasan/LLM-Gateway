import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Log entry parsing regex
 * Matches: [timestamp] [LEVEL] [TYPE] message {"payload": "optional"}
 * Pattern: \[([^\]]+)\] \[(\w+)\] \[([^\]]+)\] (.+?)(?: \{.*)?$
 */
const LOG_LINE_REGEX = /^\[([^\]]+)\] \[(\w+)\] \[([^\]]+)\] (.+)$/;

/**
 * Extract session ID from log filename
 * Format: YYYY-MM-DD-HH-MM-SS-gw-<sessionId>.log
 */
function extractSessionIdFromFilename(filename) {
    const match = filename.match(/-gw-([a-zA-Z0-9]+)\.log$/);
    return match ? match[1] : null;
}

/**
 * Parse a single log line into structured format
 * @param {string} line - Raw log line
 * @param {string} sessionId - Session ID from filename
 * @returns {object|null} Parsed log entry or null if not a valid log line
 */
function parseLogLine(line, sessionId) {
    const match = line.match(LOG_LINE_REGEX);
    if (!match) {
        return null;
    }

    const [, timestamp, level, type, rest] = match;
    
    // Validate level is one of the known levels
    const validLevels = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
    if (!validLevels.includes(level)) {
        return null;
    }

    // Try to extract message and payload
    let message = rest;
    let payload = null;

    // Look for JSON payload at the end (starts with space + {)
    // Match from the last occurrence of " {" to capture nested JSON objects
    const lastBraceIndex = rest.lastIndexOf(' {');
    if (lastBraceIndex !== -1) {
        const potentialJson = rest.slice(lastBraceIndex + 1);
        try {
            payload = JSON.parse(potentialJson);
            message = rest.slice(0, lastBraceIndex);
        } catch {
            // If JSON parsing fails, keep the original message
            message = rest;
        }
    }

    return {
        timestamp,
        level,
        type,
        message,
        payload,
        sessionId
    };
}

/**
 * Read and parse all log files from the logs directory
 * @returns {Promise<Array>} Array of parsed log entries
 */
async function readAllLogs() {
    const logsDir = path.resolve(__dirname, '../../logs');
    const entries = [];

    try {
        const files = await fs.promises.readdir(logsDir, { withFileTypes: true });
        const logFiles = files
            .filter(f => f.isFile() && f.name.endsWith('.log'))
            .map(f => f.name)
            .sort(); // Sort alphabetically (chronological due to timestamp prefix)

        for (const filename of logFiles) {
            const sessionId = extractSessionIdFromFilename(filename);
            if (!sessionId) continue;

            const filePath = path.join(logsDir, filename);
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const lines = content.split('\n');

            for (const line of lines) {
                const trimmed = line.trim();
                
                // Skip empty lines and header blocks (lines starting with =)
                if (!trimmed || trimmed.startsWith('=')) {
                    continue;
                }

                const entry = parseLogLine(trimmed, sessionId);
                if (entry) {
                    entries.push(entry);
                }
            }
        }
    } catch (error) {
        // If logs directory doesn't exist or is empty, return empty array
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    return entries;
}

/**
 * Filter log entries based on query parameters
 * @param {Array} entries - All log entries
 * @param {object} filters - Query filters
 * @returns {Array} Filtered entries
 */
function filterLogs(entries, filters) {
    let result = entries;

    // Filter by level (comma-separated)
    if (filters.level) {
        const levels = filters.level.split(',').map(l => l.trim().toUpperCase());
        result = result.filter(e => levels.includes(e.level));
    }

    // Filter by type (comma-separated, case-insensitive)
    if (filters.type) {
        const types = filters.type.split(',').map(t => t.trim());
        result = result.filter(e => types.some(t => e.type.toLowerCase() === t.toLowerCase()));
    }

    // Filter by sessionId
    if (filters.sessionId) {
        result = result.filter(e => e.sessionId === filters.sessionId);
    }

    return result;
}

/**
 * Create the logs handler
 * @returns {Function} Express handler
 */
export function createLogsHandler() {
    return async (req, res, next) => {
        try {
            // Read all logs
            let entries = await readAllLogs();

            // Apply filters
            entries = filterLogs(entries, {
                level: req.query.level,
                type: req.query.type,
                sessionId: req.query.sessionId
            });

            // Sort by timestamp descending (newest first)
            entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            // Apply limit (default 100)
            const limit = parseInt(req.query.limit, 10) || 100;
            entries = entries.slice(0, limit);

            // Return JSON response
            res.json({ logs: entries });
        } catch (error) {
            next(error);
        }
    };
}
