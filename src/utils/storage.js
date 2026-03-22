import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createSafeLogger } from './safe-logger.js';

const logger = createSafeLogger('[MediaStorage]');

export class MediaStorage {
    constructor(config = {}) {
        const storageCfg = config.mediaStorage || {};
        this.enabled = storageCfg.enabled !== false;
        this.baseDir = storageCfg.baseDir || path.join(os.tmpdir(), 'llm-gateway-media');
        this.ttlMs = Math.max(60_000, (storageCfg.ttlMinutes || 60) * 60_000);
        this.cleanupIntervalMs = Math.max(15_000, storageCfg.cleanupIntervalMs || 60_000);

        this._initPromise = null;
        this.cleanupTimer = null;

        if (this.enabled) {
            this._initPromise = this.ensureReady();
            this.cleanupTimer = setInterval(() => {
                this.evictExpiredFiles().catch(() => {
                    // Keep cleanup loop resilient even if a single pass fails
                });
            }, this.cleanupIntervalMs);
            this.cleanupTimer.unref();
        }
    }

    async ensureReady() {
        if (!this.enabled) return;
        if (!existsSync(this.baseDir)) {
            await fs.mkdir(this.baseDir, { recursive: true });
        }
    }

    _safeExt(ext) {
        if (!ext) return '.bin';
        const cleaned = String(ext).trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
        if (!cleaned) return '.bin';
        return cleaned.startsWith('.') ? cleaned : `.${cleaned}`;
    }

    async saveBuffer(buffer, ext = '.bin') {
        if (!this.enabled) {
            throw new Error('[MediaStorage] Storage is disabled');
        }

        await this._initPromise;

        const id = `media_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const safeExt = this._safeExt(ext);
        const fileName = `${id}${safeExt}`;
        const filePath = path.join(this.baseDir, fileName);

        await fs.writeFile(filePath, buffer);

        return {
            id,
            fileName,
            filePath,
            url: `/v1/media/${fileName}`,
            createdAt: Date.now()
        };
    }

    async saveBase64(base64Data, ext = '.bin') {
        const buffer = Buffer.from(base64Data, 'base64');
        return this.saveBuffer(buffer, ext);
    }

    async evictExpiredFiles() {
        if (!this.enabled) return { evictedCount: 0 };

        await this._initPromise;

        const now = Date.now();
        const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
        let evictedCount = 0;

        for (const entry of entries) {
            if (!entry.isFile()) continue;

            const filePath = path.join(this.baseDir, entry.name);
            try {
                const stat = await fs.stat(filePath);
                if (now - stat.mtimeMs > this.ttlMs) {
                    await fs.unlink(filePath);
                    evictedCount += 1;
                }
            } catch {
                // Ignore races where file disappears during cleanup
            }
        }

        if (evictedCount > 0) {
            logger.info(`evicted_files_count=${evictedCount}`, {}, 'Storage');
        }

        return { evictedCount };
    }
}
