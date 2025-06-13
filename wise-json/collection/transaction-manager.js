// wise-json/collection/transaction-manager.js

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');

class TransactionManager {
    constructor(db) {
        this.db = db; 
        this.txid = `txn_${uuidv4()}`;
        this.state = 'pending'; 
        this._ops = []; // Теперь будет содержать { colName, type, args, ts }
        this._collections = {};
    }

    collection(name) {
        if (!this._collections[name]) {
            this._collections[name] = this._createCollectionProxy(name);
        }
        return this._collections[name];
    }

    _createCollectionProxy(name) {
        const self = this;
        return {
            insert(doc) {
                self._ops.push({ colName: name, type: 'insert', args: [doc], ts: new Date().toISOString() });
                return Promise.resolve(); 
            },
            insertMany(docs) {
                self._ops.push({ colName: name, type: 'insertMany', args: [docs], ts: new Date().toISOString() });
                return Promise.resolve();
            },
            update(id, updates) {
                self._ops.push({ colName: name, type: 'update', args: [id, updates], ts: new Date().toISOString() });
                return Promise.resolve();
            },
            remove(id) {
                self._ops.push({ colName: name, type: 'remove', args: [id], ts: new Date().toISOString() });
                return Promise.resolve();
            },
            clear() {
                self._ops.push({ colName: name, type: 'clear', args: [], ts: new Date().toISOString() });
                return Promise.resolve();
            }
        };
    }

    async commit() {
        if (this.state !== 'pending') {
            throw new Error(`Transaction ${this.txid} already ${this.state}`);
        }
        this.state = 'committing';
        // logger.debug(`[TransactionManager] Committing transaction ${this.txid} with ${this._ops.length} operations.`);
        
        const walManager = require('../wal-manager.js'); // Динамический require, чтобы избежать циклических зависимостей при инициализации
        const groupedOps = this._groupOpsByCollection();

        for (const [colName, opsInCollection] of Object.entries(groupedOps)) {
            let collectionInstance;
            try {
                collectionInstance = await this.db.collection(colName);
                await collectionInstance.initPromise; 
                // opsInCollection теперь содержит операции, каждая из которых имеет свое поле 'ts'
                await walManager.writeTransactionBlock(collectionInstance.walPath, this.txid, opsInCollection);
            } catch (err) {
                this.state = 'aborted';
                const errMsg = `TransactionManager: WAL write failed for transaction ID '${this.txid}' in collection "${colName}": ${err.message}`;
                logger.error(errMsg, err.stack); // Добавим stack для большей информации
                throw new Error(errMsg);
            }
        }
        
        for (const op of this._ops) { // this._ops содержит операции с индивидуальными 'ts'
            let collectionInstance;
            try {
                collectionInstance = await this.db.collection(op.colName);
                // initPromise уже должен был разрешиться выше для каждой затронутой коллекции

                switch (op.type) {
                    case 'insert':
                        await collectionInstance._applyTransactionInsert(op.args[0], this.txid);
                        break;
                    case 'insertMany':
                        await collectionInstance._applyTransactionInsertMany(op.args[0], this.txid);
                        break;
                    case 'update':
                        await collectionInstance._applyTransactionUpdate(op.args[0], op.args[1], this.txid);
                        break;
                    case 'remove':
                        await collectionInstance._applyTransactionRemove(op.args[0], this.txid);
                        break;
                    case 'clear':
                        await collectionInstance._applyTransactionClear(this.txid);
                        break;
                    default:
                        logger.error(`[TransactionManager] Unknown transaction operation type: ${op.type} for txid ${this.txid}`);
                        throw new Error('Unknown transaction operation: ' + op.type);
                }
            } catch (err) {
                logger.error(`TransactionManager: Error applying operation (type: ${op.type}) for transaction ID '${this.txid}' in collection "${op.colName}". Error: ${err.message}`, err.stack);
            }
        }
        this.state = 'committed';
        // logger.debug(`[TransactionManager] Transaction ${this.txid} committed successfully.`);
    }

    async rollback() {
        if (this.state !== 'pending') {
            if (this.state === 'committing' || this.state === 'committed') {
                 throw new Error(`Transaction ${this.txid} cannot be rolled back, state is ${this.state}`);
            }
            // Если 'aborted', то повторный rollback ничего не делает, можно не бросать ошибку
            // logger.warn(`[TransactionManager] Rollback attempt on transaction ${this.txid} which is already ${this.state}.`);
            return; // Уже прервана или в процессе/завершена
        }
        // logger.debug(`[TransactionManager] Rolling back transaction ${this.txid}.`);
        this.state = 'aborted';
        this._ops = []; 
    }

    _groupOpsByCollection() {
        const grouped = {};
        for (const op of this._ops) { // op здесь уже содержит 'ts'
            if (!grouped[op.colName]) {
                grouped[op.colName] = [];
            }
            grouped[op.colName].push(op); 
        }
        return grouped;
    }
}

module.exports = TransactionManager;