const path = require('path');
const Collection = require('./collection/core.js');
const TransactionManager = require('./collection/transaction-manager.js');
const { makeAbsolutePath, validateOptions } = require('./collection/utils.js');

const DEFAULT_PATH = process.env.WISE_JSON_PATH || makeAbsolutePath('wise-json-db-data');

class WiseJSON {
    constructor(dbRootPath = DEFAULT_PATH, options = {}) {
        this.dbRootPath = makeAbsolutePath(dbRootPath);
        this.options = validateOptions(options);
        this.collections = {};
        this._activeTransactions = [];

        if (!WiseJSON._hasGracefulShutdown) {
            this._setupGracefulShutdown();
            WiseJSON._hasGracefulShutdown = true;
        }
    }

    async init() {
        return true;
    }

    async collection(name) {
        if (!this.collections[name]) {
            this.collections[name] = new Collection(name, this.dbRootPath, this.options);
        }
        return this.collections[name];
    }

    async getCollectionNames() {
        const fs = require('fs/promises');
        try {
            const dirs = await fs.readdir(this.dbRootPath, { withFileTypes: true });
            return dirs.filter(d => d.isDirectory()).map(d => d.name);
        } catch (e) {
            return [];
        }
    }

    async close() {
        const all = Object.values(this.collections);
        for (const col of all) {
            if (col && typeof col.close === 'function') {
                await col.close();
            }
        }
    }

    _setupGracefulShutdown() {
        const signals = ['SIGINT', 'SIGTERM'];
        signals.forEach(signal => {
            process.on(signal, async () => {
                try {
                    console.log(`\n[WiseJSON] Получен сигнал ${signal}, сохраняем все коллекции...`);
                    if (this && typeof this.close === 'function') {
                        await this.close();
                    }
                    console.log('[WiseJSON] Всё сохранено. Завершение работы.');
                } catch (e) {
                    console.error('[WiseJSON] Ошибка при автосохранении при завершении:', e);
                }
                process.exit(0);
            });
        });
    }

    /**
     * Начать транзакцию между несколькими коллекциями.
     * Возвращает объект транзакции:
     *   const txn = db.beginTransaction();
     *   await txn.collection('a').insert(...);
     *   await txn.commit();
     */
    beginTransaction() {
        const txn = new TransactionManager(this);
        this._activeTransactions.push(txn);
        return txn;
    }

    /**
     * Возвращает активные (не завершённые) транзакции.
     */
    getActiveTransactions() {
        return this._activeTransactions.filter(txn => txn.state === 'pending');
    }
}

module.exports = WiseJSON;
