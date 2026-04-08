/**
 * Local Inference Process Manager
 * Manages llama-server (and other local inference engines) as child processes.
 * Gateway controls startup, shutdown, and health monitoring.
 */

import { spawn } from 'child_process';
import process from 'process';
import { getLogger } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const logger = getLogger();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class InferenceManager {
    constructor() {
        this.processes = new Map(); // modelId -> process info
        this.healthCheckInterval = null;
    }

    /**
     * Start a local inference server for a model
     */
    async startServer(modelId, modelConfig) {
        if (this.processes.has(modelId)) {
            const existing = this.processes.get(modelId);
            if (existing.process && !existing.process.killed) {
                logger.info(`Server already running for ${modelId}`, { pid: existing.process.pid });
                return existing;
            }
        }

        const { adapter, endpoint, adapterModel, localInference } = modelConfig;

        // Only manage llama.cpp servers locally
        if (adapter !== 'llamacpp' || !localInference?.enabled) {
            throw new Error(`InferenceManager: Model ${modelId} not configured for local management`);
        }

        const port = this.extractPort(endpoint) || this.findFreePort();
        const modelPath = localInference.modelPath;
        const contextSize = localInference.contextSize || modelConfig.capabilities?.contextWindow || 4096;
        const gpuLayers = localInference.gpuLayers ?? 99;

        // Build command arguments
        // Escape # as \# to prevent it being interpreted as a comment by llama-server
        const escapedModelPath = modelPath.replace(/#/g, '\\#');
        const args = [
            '-m', escapedModelPath,
            '-c', String(contextSize),
            '-ngl', String(gpuLayers),
            '--port', String(port),
            '--host', '127.0.0.1'
        ];

        // Add optional parameters
        if (localInference.threads) args.push('-t', String(localInference.threads));
        if (localInference.batchSize) args.push('-b', String(localInference.batchSize));
        if (localInference.flashAttention) {
            // --flash-attn expects a value: on|off|auto
            const faValue = typeof localInference.flashAttention === 'string' 
                ? localInference.flashAttention 
                : 'on';
            args.push('--flash-attn', faValue);
        }
        
        // Performance optimizations
        if (localInference.mlock) args.push('--mlock');
        if (localInference.noMmap) args.push('--no-mmap');
        if (localInference.contBatching !== false) args.push('--cont-batching'); // default on
        if (localInference.cacheTypeK) args.push('--cache-type-k', localInference.cacheTypeK);
        if (localInference.cacheTypeV) args.push('--cache-type-v', localInference.cacheTypeV);
        if (localInference.ubatchSize) args.push('-ub', String(localInference.ubatchSize));
        if (localInference.parallel) args.push('-np', String(localInference.parallel)); // parallel slots
        if (localInference.splitMode) args.push('--split-mode', localInference.splitMode); // layer/node/none
        
        // Embedding mode
        if (localInference.embedding) args.push('--embedding');
        if (localInference.pooling) args.push('--pooling', localInference.pooling);
        
        // Keep-alive / prevent idle shutdown (for LMStudio-like behavior)
        if (localInference.noClearIdle) args.push('--no-clear-idle');
        if (localInference.sleepIdleSeconds !== undefined) {
            args.push('--sleep-idle-seconds', String(localInference.sleepIdleSeconds));
        }
        if (localInference.timeout) args.push('-to', String(localInference.timeout));

        const inferenceDir = path.join(__dirname, '../../inference');
        const serverPath = path.join(inferenceDir, 'llama-server.exe');

        logger.info(`Starting inference server for ${modelId}`, {
            modelPath,
            port,
            contextSize,
            gpuLayers,
            serverPath,
            cwd: inferenceDir,
            args: args.join(' ')
        });

        const childProcess = spawn(serverPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: false, // Show window for debugging
            cwd: inferenceDir,  // Set working directory so DLLs are found
            env: {
                ...global.process.env,
                PATH: inferenceDir + ';' + global.process.env.PATH
            }
        });

        const processInfo = {
            process: childProcess,
            modelId,
            port,
            pid: childProcess.pid,
            startTime: Date.now(),
            status: 'starting'
        };

        this.processes.set(modelId, processInfo);

        // Handle process output - pipe all stdout/stderr through logger
        childProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output.includes('http server listening')) {
                processInfo.status = 'ready';
                logger.info(`Server ready for ${modelId}`, { port, pid: childProcess.pid });
            }
            logger.debug(`[${modelId}] stdout`, { output: output.substring(0, 500) });
        });

        childProcess.stderr.on('data', (data) => {
            const output = data.toString().trim();
            // Log all stderr output - errors and warnings are critical for debugging
            logger.info(`[${modelId}] stderr`, { output: output.substring(0, 1000) });
        });

        childProcess.on('error', (err) => {
            logger.error(`Server error for ${modelId}`, err);
            processInfo.status = 'error';
        });

        childProcess.on('exit', (code) => {
            logger.info(`Server exited for ${modelId}`, { code });
            processInfo.status = code === 0 ? 'stopped' : 'crashed';
            if (this.processes.get(modelId)?.process === childProcess) {
                this.processes.delete(modelId);
            }
        });

        // Wait for server to be ready
        await this.waitForServer(port, 60000); // 60 second timeout
        
        return processInfo;
    }

    /**
     * Stop a running inference server
     */
    async stopServer(modelId) {
        const processInfo = this.processes.get(modelId);
        if (!processInfo) {
            logger.warn(`No server found for ${modelId}`);
            return;
        }

        const childProcess = processInfo.process;
        
        logger.info(`Stopping inference server for ${modelId}`, { pid: childProcess.pid });

        // Try graceful shutdown first
        childProcess.kill('SIGTERM');

        // Force kill after 10 seconds if still running
        setTimeout(() => {
            if (!childProcess.killed) {
                logger.warn(`Force killing server for ${modelId}`);
                childProcess.kill('SIGKILL');
            }
        }, 10000);

        this.processes.delete(modelId);
    }

    /**
     * Check if server is ready by polling
     */
    async waitForServer(port, timeoutMs = 60000) {
        const start = Date.now();
        
        while (Date.now() - start < timeoutMs) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
                    method: 'GET',
                    signal: AbortSignal.timeout(1000)
                });
                if (res.ok) return;
            } catch {
                // Not ready yet
            }
            await new Promise(r => setTimeout(r, 500));
        }

        throw new Error(`Server failed to start within ${timeoutMs}ms`);
    }

    /**
     * Get status of all managed servers
     */
    getStatus() {
        return Array.from(this.processes.entries()).map(([modelId, info]) => ({
            modelId,
            pid: info.pid,
            port: info.port,
            status: info.status,
            uptime: Date.now() - info.startTime
        }));
    }

    /**
     * Stop all servers on shutdown
     */
    async shutdown() {
        logger.info('Shutting down all inference servers');
        const promises = Array.from(this.processes.keys()).map(id => this.stopServer(id));
        await Promise.all(promises);
    }

    extractPort(endpoint) {
        const match = endpoint?.match(/:(\d+)$/);
        return match ? parseInt(match[1], 10) : null;
    }

    findFreePort() {
        // Simple port selection - start from 12346
        const basePort = 12346;
        const usedPorts = new Set(Array.from(this.processes.values()).map(p => p.port));
        
        for (let port = basePort; port < basePort + 100; port++) {
            if (!usedPorts.has(port)) return port;
        }
        
        throw new Error('No free ports available');
    }
}

// Singleton instance
let instance = null;

export function getInferenceManager() {
    if (!instance) {
        instance = new InferenceManager();
    }
    return instance;
}
