// wise-json/sync/sync-manager.js

const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const { readWal } = require('../wal-manager.js');

/**
 * SyncManager - orchestrates robust, two-way synchronization with a remote server.
 * Implements an advanced sync strategy including LSN-based delta sync, push batching,
 * adaptive intervals, heartbeats, and idempotent pushes.
 */
class SyncManager extends EventEmitter {
    /**
     * @param {object} params
     * @param {import('../collection/core')} params.collection - The collection instance to sync.
     * @param {object} params.apiClient - The API client for server communication.
     * @param {object} [params.logger] - Optional logger instance.
     * @param {number} [params.minSyncIntervalMs=5000] - The base interval for sync attempts.
     * @param {number} [params.maxSyncIntervalMs=60000] - The maximum interval for adaptive backoff.
     * @param {number} [params.heartbeatIntervalMs=30000] - How often to send a heartbeat if no other activity.
     * @param {number} [params.pushBatchSize=100] - The maximum number of operations to push in a single batch.
     * @param {boolean} [params.autoStartLoop=true] - Whether to start the sync loop automatically.
     */
    constructor({
        collection,
        apiClient,
        logger,
        minSyncIntervalMs = 5000,
        maxSyncIntervalMs = 60000,
        heartbeatIntervalMs = 30000,
        pushBatchSize = 100,
        autoStartLoop = true,
    }) {
        super();
        if (!collection || !apiClient) {
            throw new Error('SyncManager requires both "collection" and "apiClient" instances.');
        }

        this.collection = collection;
        this.apiClient = apiClient;
        this.pushBatchSize = pushBatchSize;
        this.minSyncIntervalMs = minSyncIntervalMs;
        this.maxSyncIntervalMs = maxSyncIntervalMs;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.autoStartLoop = autoStartLoop;
        this.logger = logger || require('../logger');

        this._state = 'stopped'; // stopped, idle, syncing, error
        this._isSyncing = false;
        this._initialSyncComplete = false;
        this._timeoutId = null;

        this.lastKnownServerLSN = 0;
        this.currentInterval = this.minSyncIntervalMs;
        this.lastActivityTime = Date.now();
    }

    start() {
        if (this._state !== 'stopped') return;
        this.logger.log(`[SyncManager] Starting for collection '${this.collection.name}'.`);
        this._state = 'idle';
        if (this.autoStartLoop) {
            this._runLoop();
        }
    }

    stop() {
        if (this._timeoutId) {
            clearTimeout(this._timeoutId);
            this._timeoutId = null;
        }
        this._state = 'stopped';
        this.logger.log(`[SyncManager] Stopped for collection '${this.collection.name}'.`);
    }

    getStatus() {
        return {
            state: this._state,
            isSyncing: this._isSyncing,
            initialSyncComplete: this._initialSyncComplete,
            lastKnownServerLSN: this.lastKnownServerLSN,
            currentInterval: this.currentInterval,
        };
    }

    async runSync() {
        if (this._isSyncing || this._state === 'stopped') {
            return;
        }
        this._isSyncing = true;
        await this._doSync();
        this._isSyncing = false;
    }

    _runLoop() {
        if (this._state === 'stopped') return;

        this.runSync().finally(() => {
            if (this._state !== 'stopped' && this.autoStartLoop) {
                this._timeoutId = setTimeout(() => this._runLoop(), this.currentInterval);
            }
        });
    }

    async _doSync() {
        this._state = 'syncing';
        this.emit('sync:start', { lsn: this.lastKnownServerLSN });

        try {
            // --- ИСПРАВЛЕННАЯ ЛОГИКА НАЧАЛЬНОЙ СИНХРОНИЗАЦИИ ---

            // Проверяем, есть ли у нас локальные изменения, которые нужно отправить ПЕРЕД начальной синхронизацией.
            const walEntries = await readWal(this.collection.walPath, null, { recover: true, logger: this.logger });
            const localWalEntries = walEntries.filter(entry => !entry._remote);

            // Если у нас нет локальных изменений и мы ни разу не синхронизировались,
            // то можно безопасно выполнить начальную полную синхронизацию (snapshot), которая перезатрет локальные данные.
            if (!this._initialSyncComplete && localWalEntries.length === 0) {
                await this._performInitialSync();
            }
            
            // В любом случае, после этого ставим флаг, что попытка начальной синхронизации была.
            // Если у клиента были локальные данные, он пропустит snapshot и сразу перейдет к PULL/PUSH.
            this._initialSyncComplete = true; 

            // --- КОНЕЦ ИСПРАВЛЕННОЙ ЛОГИКИ ---

            // Теперь выполняем стандартный цикл PULL -> PUSH
            const pullActivity = await this._performPull();
            const pushActivity = await this._performPush();
            
            const activityDetected = pullActivity || pushActivity;
            if (!activityDetected && Date.now() - this.lastActivityTime > this.heartbeatIntervalMs) {
                await this._performHeartbeat();
            }

            if (activityDetected) {
                this.currentInterval = this.minSyncIntervalMs;
                this.lastActivityTime = Date.now();
            } else {
                this.currentInterval = Math.min(this.currentInterval * 1.5, this.maxSyncIntervalMs);
            }

            this._state = 'idle';
            this.emit('sync:success', {
                type: 'full_cycle_complete',
                lsn: this.lastKnownServerLSN,
                activityDetected,
            });

        } catch (err) {
            this._state = 'error';
            this.currentInterval = Math.min(this.currentInterval * 2, this.maxSyncIntervalMs);
            this.emit('sync:error', {
                message: `Sync cycle failed: ${err.message}`,
                originalError: err,
            });
        }
    }

    async _performInitialSync() {
        this.emit('sync:initial_start');
        try {
            const snapshot = await this.apiClient.get('/sync/snapshot');

            if (!snapshot || !Array.isArray(snapshot.documents) || typeof snapshot.server_lsn !== 'number') {
                this.emit('sync:initial_complete', { message: 'Snapshot not available or invalid. Continuing with delta sync.' });
                return;
            }
            
            await this.collection._internalClear();
            await this.collection._internalInsertMany(snapshot.documents);

            this.lastKnownServerLSN = snapshot.server_lsn;
            this.lastActivityTime = Date.now();

            this.emit('sync:initial_complete', {
                documentsLoaded: snapshot.documents.length,
                lsn: this.lastKnownServerLSN,
            });
        } catch (err) {
            throw new Error(`Initial sync failed: ${err.message}`);
        }
    }

    async _performPull() {
        const pullUrl = `/sync/pull?since_lsn=${this.lastKnownServerLSN}`;
        const response = await this.apiClient.get(pullUrl);

        if (!response || !Array.isArray(response.ops) || response.ops.length === 0) {
            return false;
        }

        const serverOps = response.ops;
        for (const op of serverOps) {
            await this.collection._applyRemoteOperation(op);
        }

        if (typeof response.server_lsn === 'number') {
            this.lastKnownServerLSN = response.server_lsn;
        }

        this.emit('sync:pull_success', { pulled: serverOps.length, lsn: this.lastKnownServerLSN });
        return true;
    }

    async _performPush() {
        const allWalEntries = await readWal(this.collection.walPath, null, { recover: true, logger: this.logger });
        const localWalEntries = allWalEntries.filter(entry => !entry._remote);

        if (localWalEntries.length === 0) {
            return false;
        }

        let allBatchesPushedSuccessfully = true;

        for (let i = 0; i < localWalEntries.length; i += this.pushBatchSize) {
            const batch = localWalEntries.slice(i, i + this.pushBatchSize);
            const batchId = uuidv4();

            try {
                const response = await this.apiClient.post('/sync/push', { batchId, ops: batch });
                
                if (typeof response.server_lsn === 'number') {
                    this.lastKnownServerLSN = response.server_lsn;
                }

                this.emit('sync:push_success', {
                    pushed: batch.length,
                    batchId: batchId,
                    lsn: this.lastKnownServerLSN,
                });
            } catch (err) {
                allBatchesPushedSuccessfully = false;
                throw new Error(`Push failed on batch ${batchId}: ${err.message}`);
            }
        }
        
        if (allBatchesPushedSuccessfully) {
            await this.collection.compactWalAfterPush();
        }
        
        return true;
    }
    
    async _performHeartbeat() {
        try {
            await this.apiClient.get('/sync/health');
            this.lastActivityTime = Date.now();
            this.emit('sync:heartbeat_success');
        } catch (err) {
            throw new Error(`Heartbeat failed: ${err.message}`);
        }
    }
}

module.exports = SyncManager;