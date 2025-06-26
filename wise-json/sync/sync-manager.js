// wise-json/sync/sync-manager.js

const EventEmitter = require('events');
const { readWal } = require('../wal-manager.js'); // Зависимость от wal-manager, а не wal-ops
const logger = require('../logger');

/**
 * SyncManager отвечает за двустороннюю синхронизацию коллекции с удалённым сервером.
 * Управляет полным жизненным циклом: начальная загрузка, отправка (push) и получение (pull) изменений.
 */
class SyncManager extends EventEmitter {
    /**
     * @param {object} params
     * @param {import('../collection/core')} params.collection - Экземпляр коллекции.
     * @param {object} params.apiClient - Клиент для общения с сервером.
     * @param {number} [params.syncIntervalMs=10000] - Интервал между попытками синхронизации.
     * @param {number} [params.pushBatchSize=100] - Максимальный размер пакета операций для отправки на сервер.
     */
    constructor({ collection, apiClient, syncIntervalMs = 10000, pushBatchSize = 100 }) {
        super();
        if (!collection) {
            throw new Error('SyncManager requires a "collection" instance.');
        }
        this.collection = collection;
        this.apiClient = apiClient;
        this.syncIntervalMs = syncIntervalMs;
        this.pushBatchSize = pushBatchSize;

        this.lastSyncTimestamp = null;
        this._state = 'idle'; // idle, syncing, error
        this._initialSyncComplete = false;
        this._timer = null;
        this._isSyncing = false;
    }

    start() {
        if (this._timer) return;
        this._state = 'idle';
        this._timer = setInterval(() => this.runSync(), this.syncIntervalMs);
        this.runSync(); // Первый запуск сразу
    }

    stop() {
        this._state = 'stopped';
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    getStatus() {
        return {
            state: this._state,
            isSyncing: this._isSyncing,
            initialSyncComplete: this._initialSyncComplete,
            lastSyncTimestamp: this.lastSyncTimestamp,
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

    async _doSync() {
        this._state = 'syncing';
        this.emit('sync:start');

        try {
            // Этап 1: Начальная полная синхронизация (если требуется)
            if (!this._initialSyncComplete) {
                await this._performInitialSync();
                this._initialSyncComplete = true;
            }

            // Этап 2: PUSH локальных изменений пакетами
            await this._performPush();

            // Этап 3: PULL дельта-изменений с сервера
            await this._performPull();

            this._state = 'idle';
            this.emit('sync:success', {
                type: 'full_cycle_complete',
                timestamp: this.lastSyncTimestamp,
            });

        } catch (err) {
            this._state = 'error';
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

            if (!snapshot || !Array.isArray(snapshot.documents) || !snapshot.timestamp) {
                this.emit('sync:initial_complete', { message: 'Snapshot not available or invalid, skipping.' });
                logger.log('[SyncManager] Snapshot endpoint not available or returned invalid data. Skipping initial sync.');
                return;
            }

            await this.collection._internalClear();
            await this.collection._internalInsertMany(snapshot.documents);

            this.lastSyncTimestamp = snapshot.timestamp;

            this.emit('sync:initial_complete', {
                documentsLoaded: snapshot.documents.length,
                timestamp: snapshot.timestamp,
            });

        } catch (err) {
            throw new Error(`Initial sync failed: ${err.message}`);
        }
    }

    async _performPush() {
        const walEntries = await readWal(this.collection.walPath, this.lastSyncTimestamp, { recover: true });

        if (walEntries.length === 0) {
            return;
        }

        for (let i = 0; i < walEntries.length; i += this.pushBatchSize) {
            const batch = walEntries.slice(i, i + this.pushBatchSize);
            
            try {
                // Сервер должен принимать объект { ops: [...] }
                await this.apiClient.post('/sync/push', { ops: batch });

                const lastOpInBatch = batch[batch.length - 1];
                const timestamp = lastOpInBatch.ts || lastOpInBatch.doc?.updatedAt || lastOpInBatch.data?.updatedAt;
                if (timestamp) {
                    this.lastSyncTimestamp = new Date(timestamp).toISOString();
                }

                this.emit('sync:push_success', {
                    pushed: batch.length,
                    total: walEntries.length,
                    batch: i / this.pushBatchSize + 1,
                    totalBatches: Math.ceil(walEntries.length / this.pushBatchSize),
                });
            } catch (err) {
                throw new Error(`Push failed on batch: ${err.message}`);
            }
        }
    }

    async _performPull() {
        const pullUrl = this.lastSyncTimestamp ? `/sync/pull?since=${this.lastSyncTimestamp}` : '/sync/pull';
        const serverOps = await this.apiClient.get(pullUrl);

        if (!Array.isArray(serverOps) || serverOps.length === 0) {
            return;
        }

        for (const op of serverOps) {
            await this.collection._applyRemoteOperation(op);
        }

        const lastServerOp = serverOps[serverOps.length - 1];
        const timestamp = lastServerOp.ts || lastServerOp.doc?.updatedAt || lastServerOp.data?.updatedAt;
        if (timestamp) {
            this.lastSyncTimestamp = new Date(timestamp).toISOString();
        }

        this.emit('sync:pull_success', { pulled: serverOps.length });
    }
}

module.exports = SyncManager;