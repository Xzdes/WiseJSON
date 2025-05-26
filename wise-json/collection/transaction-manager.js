// wise-json/collection/transaction-manager.js

const { v4: uuidv4 } = require('uuid');

/**
 * TransactionManager управляет транзакцией между несколькими коллекциями.
 * Используется только внутри WiseJSON.
 */
class TransactionManager {
    constructor(db) {
        this.db = db; // ссылка на WiseJSON
        this.txid = `txn_${uuidv4()}`;
        this.state = 'pending'; // pending | committed | aborted
        this._ops = []; // { colName, type, args }
        this._collections = {};
    }

    /**
     * Получить обёртку коллекции для транзакции.
     * Все изменения копятся до commit().
     */
    collection(name) {
        if (!this._collections[name]) {
            this._collections[name] = this._createCollectionProxy(name);
        }
        return this._collections[name];
    }

    _createCollectionProxy(name) {
        const self = this;
        // Обёртка, которая не вызывает реальный insert/update/remove, а сохраняет intent
        return {
            insert(doc) {
                self._ops.push({ colName: name, type: 'insert', args: [doc] });
                return Promise.resolve(); // для совместимости с async
            },
            insertMany(docs) {
                self._ops.push({ colName: name, type: 'insertMany', args: [docs] });
                return Promise.resolve();
            },
            update(id, updates) {
                self._ops.push({ colName: name, type: 'update', args: [id, updates] });
                return Promise.resolve();
            },
            remove(id) {
                self._ops.push({ colName: name, type: 'remove', args: [id] });
                return Promise.resolve();
            },
            clear() {
                self._ops.push({ colName: name, type: 'clear', args: [] });
                return Promise.resolve();
            }
            // Можно добавить другие методы по необходимости
        };
    }

    /**
     * Атомарно записывает все операции в WAL всех коллекций и применяет их.
     * После commit никаких rollback!
     */
    async commit() {
        if (this.state !== 'pending') throw new Error('Transaction already committed or aborted');
        this.state = 'committing';
        const walManager = require('../wal-manager.js');
        // 1. Записать в WAL транзакционный блок
        const groupedOps = this._groupOpsByCollection();
        for (const [colName, ops] of Object.entries(groupedOps)) {
            const collection = await this.db.collection(colName);
            await collection.initPromise;
            // Записываем весь блок одной транзакции в WAL с пометками txn
            await walManager.writeTransactionBlock(collection.walPath, this.txid, ops);
        }
        // 2. Применить к данным в коллекциях
        for (const op of this._ops) {
            const collection = await this.db.collection(op.colName);
            await collection.initPromise;
            switch (op.type) {
                case 'insert':
                    await collection._applyTransactionInsert(op.args[0], this.txid);
                    break;
                case 'insertMany':
                    await collection._applyTransactionInsertMany(op.args[0], this.txid);
                    break;
                case 'update':
                    await collection._applyTransactionUpdate(op.args[0], op.args[1], this.txid);
                    break;
                case 'remove':
                    await collection._applyTransactionRemove(op.args[0], this.txid);
                    break;
                case 'clear':
                    await collection._applyTransactionClear(this.txid);
                    break;
                default:
                    throw new Error('Unknown transaction operation: ' + op.type);
            }
        }
        this.state = 'committed';
    }

    /**
     * Откатывает все pending‑операции (ничего не записывается в WAL).
     */
    async rollback() {
        if (this.state !== 'pending') throw new Error('Transaction already committed or aborted');
        this.state = 'aborted';
        this._ops = [];
        // Реально в базе ничего не меняется
    }

    _groupOpsByCollection() {
        const grouped = {};
        for (const op of this._ops) {
            if (!grouped[op.colName]) grouped[op.colName] = [];
            grouped[op.colName].push(op);
        }
        return grouped;
    }
}

module.exports = TransactionManager;
