// wise-json/sync/sync-manager.js

const EventEmitter = require('events');
const { readWal } = require('../collection/wal-ops.js');

/**
 * SyncManager отвечает за двустороннюю синхронизацию коллекции с удалённым сервером.
 * Он следит за локальными изменениями (WAL), пушит их на сервер, и забирает обновления с сервера (pull).
 */
class SyncManager extends EventEmitter {
    /**
     * @param {object} params
     * @param {object} params.collection - Экземпляр коллекции, с которой работает SyncManager.
     * @param {object} params.apiClient - Клиент для общения с сервером (методы post, get).
     * @param {number} [params.syncIntervalMs=1000] - Интервал между попытками синхронизации.
     */
    constructor({ collection, apiClient, syncIntervalMs = 1000 }) {
        super();
        if (!collection) {
            // Безопасная диагностика при инициализации
            console.error('[SyncManager] Коллекция (collection) не передана или не инициализирована!');
            throw new Error('SyncManager требует параметр collection! Проверь создание через Collection.enableSync или new SyncManager({ collection: ... })');
        }
        this.collection = collection;
        this.apiClient = apiClient;
        this.syncIntervalMs = syncIntervalMs;

        this.lastSyncTimestamp = null; // ISO строка (UTC), или null если ни разу не было sync
        this._timer = null;
        this._stopped = false;
        this._isSyncing = false;
        this._pendingPromise = null;
    }

    start() {
        if (this._timer) return;
        this._stopped = false;
        this._timer = setInterval(() => this.runSync(), this.syncIntervalMs);
        // Первый sync — сразу
        this.runSync();
    }

    stop() {
        this._stopped = true;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async runSync() {
        if (this._isSyncing || this._stopped) return this._pendingPromise;
        this._isSyncing = true;
        this._pendingPromise = this._doSync().finally(() => {
            this._isSyncing = false;
        });
        return this._pendingPromise;
    }

    /**
     * Главная логика синхронизации
     */
async _doSync() {
    try {
        // 1. Получить новые локальные изменения для PUSH (WAL)
        const walEntries = await readWal(this.collection);

        let localOpsForPush;
        if (!this.lastSyncTimestamp) {
            localOpsForPush = walEntries;
        } else {
            const lastSyncTime = new Date(this.lastSyncTimestamp).getTime();
            localOpsForPush = walEntries.filter(op => {
                const ts = op.updatedAt || op.createdAt;
                return ts && new Date(ts).getTime() >= lastSyncTime;
            });
        }

        // 2. PUSH локальных изменений на сервер (если есть)
        if (localOpsForPush.length > 0) {
            try {
                await this.apiClient.post('/sync/push', localOpsForPush);

                // НАДЁЖНАЯ обработка времени
                const times = localOpsForPush
                    .map(op => new Date(op.updatedAt || op.createdAt).getTime())
                    .filter(ts => !isNaN(ts));
                if (times.length > 0) {
                    const maxTime = Math.max(...times);
                    this.lastSyncTimestamp = new Date(maxTime).toISOString();
                }

                this.emit('sync:success', { pushed: localOpsForPush.length });
            } catch (err) {
                this.emit('sync:error', err);
                // throw err; // Не бросаем дальше, чтобы событие ловилось только через emit
                return; // завершаем sync
            }
        }

        // 3. PULL изменений с сервера
        try {
            const serverOps = await this.apiClient.get('/sync/pull');

            if (Array.isArray(serverOps) && serverOps.length > 0) {
                for (const op of serverOps) {
                    if (typeof this.collection._applyRemoteOperation === 'function') {
                        await this.collection._applyRemoteOperation(op);
                    }
                }

                // обновляем lastSyncTimestamp на основе serverOps
                const times = serverOps
                    .map(op => new Date(op.updatedAt || op.createdAt).getTime())
                    .filter(ts => !isNaN(ts));
                if (times.length > 0) {
                    const maxServerOpTime = Math.max(...times);
                    if (
                        !this.lastSyncTimestamp ||
                        maxServerOpTime > new Date(this.lastSyncTimestamp).getTime()
                    ) {
                        this.lastSyncTimestamp = new Date(maxServerOpTime).toISOString();
                    }
                }
            }
        } catch (err) {
            this.emit('sync:error', err);
            // throw err; // Не бросаем дальше, чтобы событие ловилось только через emit
            return;
        }

    } catch (err) {
        this.emit('sync:error', err);
        // throw err; // Не бросаем дальше, чтобы событие ловилось только через emit
        return;
    }
}


}

module.exports = SyncManager;