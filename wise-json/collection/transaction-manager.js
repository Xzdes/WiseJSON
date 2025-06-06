// wise-json/collection/transaction-manager.js

const { v4: uuidv4 } = require('uuid');

/**
 * TransactionManager управляет транзакцией между несколькими коллекциями.
 * Используется только внутри WiseJSON.
 *
 * @class
 * @example
 * const txn = db.beginTransaction();
 * await txn.collection('users').insert({ name: 'Petya' });
 * await txn.collection('accounts').update(id, {...});
 * await txn.commit();
 */
class TransactionManager {
    /**
     * @param {object} db - Экземпляр WiseJSON
     */
    constructor(db) {
        this.db = db; // ссылка на WiseJSON
        this.txid = `txn_${uuidv4()}`;
        this.state = 'pending'; // pending | committed | aborted | committing
        this._ops = []; // { colName, type, args }
        this._collections = {};
    }

    /**
     * Получить обёртку коллекции для транзакции.
     * Все изменения копятся до commit().
     * @param {string} name - Имя коллекции
     * @returns {object} Proxy-объект для insert/update/remove/clear
     */
    collection(name) {
        if (!this._collections[name]) {
            this._collections[name] = this._createCollectionProxy(name);
        }
        return this._collections[name];
    }

    /**
     * @private
     * Создаёт прокси для коллекции — не выполняет действия сразу, только накапливает их.
     * @param {string} name
     * @returns {object}
     */
    _createCollectionProxy(name) {
        const self = this;
        // Обёртка, которая не вызывает реальный insert/update/remove, а сохраняет intent
        return {
            /**
             * @param {object} doc
             * @returns {Promise<void>}
             */
            insert(doc) {
                self._ops.push({ colName: name, type: 'insert', args: [doc] });
                return Promise.resolve(); // для совместимости с async
            },
            /**
             * @param {object[]} docs
             * @returns {Promise<void>}
             */
            insertMany(docs) {
                self._ops.push({ colName: name, type: 'insertMany', args: [docs] });
                return Promise.resolve();
            },
            /**
             * @param {string} id
             * @param {object} updates
             * @returns {Promise<void>}
             */
            update(id, updates) {
                self._ops.push({ colName: name, type: 'update', args: [id, updates] });
                return Promise.resolve();
            },
            /**
             * @param {string} id
             * @returns {Promise<void>}
             */
            remove(id) {
                self._ops.push({ colName: name, type: 'remove', args: [id] });
                return Promise.resolve();
            },
            /**
             * @returns {Promise<void>}
             */
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
     *
     * @async
     * @throws {Error} Если транзакция уже завершена (committed/aborted)
     *
     * @returns {Promise<void>}
     *
     * @assumption
     *   - Если запись транзакционного блока WAL в одной из коллекций завершится с ошибкой,
     *     остальные коллекции уже могут иметь WAL-запись (а могут и не иметь).
     *   - Нет глобального rollback: если сбой при записи WAL-файла хотя бы одной коллекции —
     *     возможен частичный коммит транзакции (и она будет проигнорирована при восстановлении).
     *   - На этапе применения операций (после записи WAL) ошибки не приводят к rollback уже записанных изменений.
     *   - Данная схема надёжна для большинства случаев, но не гарантирует "2-phase commit" между коллекциями при сбоях ФС.
     *   - См. также ASSUMPTION в wal-manager.js/readWal: только полностью записанные транзакционные блоки применяются.
     */
    async commit() {
        if (this.state !== 'pending') throw new Error('Transaction already committed or aborted');
        this.state = 'committing';
        const walManager = require('../wal-manager.js');
        // 1. Записать в WAL транзакционный блок для каждой коллекции
        const groupedOps = this._groupOpsByCollection();
        for (const [colName, ops] of Object.entries(groupedOps)) {
            const collection = await this.db.collection(colName);
            await collection.initPromise;
            try {
                // ASSUMPTION: Запись транзакционного блока WAL может упасть только для одной коллекции.
                // В случае ошибки — транзакция может быть применена частично (но только если блок WAL полностью записан и завершён commit'ом).
                await walManager.writeTransactionBlock(collection.walPath, this.txid, ops);
            } catch (err) {
                // ASSUMPTION: Если при записи WAL возникла ошибка — транзакция может остаться "висящей" или быть частично зафиксирована только в некоторых коллекциях.
                // Восстановление (readWal) не применяет незавершённые транзакции.
                // TODO: В будущем можно реализовать компенсационные действия или "2-phase commit".
                this.state = 'aborted';
                throw new Error(`TransactionManager: WAL write failed for collection "${colName}": ${err.message}`);
            }
        }
        // 2. Применить к данным в коллекциях
        for (const op of this._ops) {
            const collection = await this.db.collection(op.colName);
            await collection.initPromise;
            try {
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
            } catch (err) {
                // ASSUMPTION: Ошибки на этом этапе не приводят к откату WAL; требуется ручное вмешательство, если нужно полное восстановление.
                // TODO: В будущем возможна компенсация (rollback) или запись ошибок в отдельный журнал.
                console.error(`TransactionManager: Ошибка применения операции в коллекции "${op.colName}": ${err.message}`);
                // Не прерываем остальные операции, чтобы не создавать неконсистентность между коллекциями.
            }
        }
        this.state = 'committed';
    }

    /**
     * Откатывает все pending‑операции (ничего не записывается в WAL).
     * @returns {Promise<void>}
     * @throws {Error} Если транзакция уже завершена (committed/aborted)
     *
     * @assumption
     *   - Откат возможен только до вызова commit().
     *   - Если был вызван commit(), rollback невозможен.
     *   - Никаких изменений в данных или WAL не производится при rollback.
     */
    async rollback() {
        if (this.state !== 'pending') throw new Error('Transaction already committed or aborted');
        this.state = 'aborted';
        this._ops = [];
        // Реально в базе ничего не меняется
    }

    /**
     * @private
     * Группирует операции по коллекциям для пакетной записи в WAL.
     * @returns {Object.<string, Array>} - { [colName]: [ops...] }
     */
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
