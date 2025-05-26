const path = require('path');
const fs = require('fs/promises');
const CollectionEventEmitter = require('./events.js');
const createWalOps = require('./wal-ops.js');
const IndexManager = require('./indexes.js');
const createCheckpointController = require('./checkpoints.js');
const {
    defaultIdGenerator,
    isNonEmptyString,
    isPlainObject,
    makeAbsolutePath,
    validateOptions
} = require('./utils.js');
const { initializeWal, readWal, getWalPath, compactWal } = require('../wal-manager.js');
const { loadLatestCheckpoint } = require('../checkpoint-manager.js');
const { cleanupExpiredDocs, isAlive } = require('./ttl.js');

class Collection {
    constructor(name, dbRootPath, options = {}) {
        if (!isNonEmptyString(name)) {
            throw new Error('Collection: имя коллекции должно быть непустой строкой.');
        }

        this.name = name;
        this.options = validateOptions(options);
        this.dbRootPath = makeAbsolutePath(dbRootPath);
        this.collectionDirPath = path.resolve(this.dbRootPath, name);

        this.documents = new Map();
        this._idGenerator = typeof this.options.idGenerator === 'function' ? this.options.idGenerator : defaultIdGenerator;
        this._writeQueue = [];
        this._writing = false;

        this._emitter = new CollectionEventEmitter(name);
        this._indexManager = new IndexManager(name);
        this.walPath = getWalPath(this.collectionDirPath, name);

        this._checkpoint = createCheckpointController({
            collectionName: name,
            collectionDirPath: this.collectionDirPath,
            documents: this.documents,
            options: this.options,
            getIndexesMeta: () => this._indexManager.getIndexesMeta(),
        });

        const walOps = createWalOps({
            documents: this.documents,
            _performCheckpoint: () => this._checkpoint.saveCheckpoint(),
            _emitter: this._emitter,
            _updateIndexesAfterInsert: doc => this._indexManager.afterInsert(doc),
            _updateIndexesAfterRemove: doc => this._indexManager.afterRemove(doc),
            _updateIndexesAfterUpdate: (oldDoc, newDoc) => this._indexManager.afterUpdate(oldDoc, newDoc),
            _triggerCheckpointIfRequired: () => {},
            options: this.options,
            walPath: this.walPath,
        });

        this.applyWalEntryToMemory = walOps.applyWalEntryToMemory;
        this._enqueueDataModification = walOps.enqueueDataModification;

        this._stats = { inserts: 0, updates: 0, removes: 0, clears: 0 };

        this.initPromise = this._initialize();

        this._setupGracefulShutdown();

        this._lastCheckpointTimestamp = null;

        this._ttlCleanupIntervalMs = this.options.ttlCleanupIntervalMs || 60 * 1000;
        this._ttlCleanupTimer = null;
        this._startTtlCleanupTimer();
    }

    async _initialize() {
        await fs.mkdir(this.collectionDirPath, { recursive: true });
        await initializeWal(this.walPath, this.collectionDirPath);

        // 1. Загружаем последний чекпоинт
        const loaded = await loadLatestCheckpoint(
            path.join(this.collectionDirPath, '_checkpoints'),
            this.name
        );

        if (loaded && loaded.documents && loaded.documents.size > 0) {
            console.log(`[WiseJSON] ✅ Checkpoint loaded: ${loaded.documents.size} documents (collection: ${this.name})`);
        } else {
            console.warn(`[WiseJSON] ⚠ No checkpoint found for collection: ${this.name}`);
        }

        for (const [id, doc] of loaded.documents.entries()) {
            this.documents.set(id, doc);
        }

        for (const indexMeta of loaded.indexesMeta) {
            try {
                this._indexManager.createIndex(indexMeta.fieldName, {
                    unique: indexMeta.type === 'unique',
                });
            } catch (e) {
                console.warn(`[WiseJSON] ⚠ Failed to restore index '${indexMeta.fieldName}': ${e.message}`);
            }
        }

        // 2. Проигрываем WAL — это ДОПОЛНЕНИЕ к чекпоинту
        const walEntries = await readWal(this.walPath, loaded.timestamp);
        if (walEntries.length > 0) {
            console.log(`[WiseJSON] 📝 Applying ${walEntries.length} WAL entries for collection: ${this.name}`);
        }
        for (const entry of walEntries) {
            // Если операция — из транзакции, применяем только если есть COMMIT
            if (entry.txn === 'op' && entry._txn_applied) {
                await this._applyTransactionWalOp(entry);
            } else if (!entry.txn) {
                this.applyWalEntryToMemory(entry, false);
            }
            // Прочие случаи — игнорируем (незавершённые транзакции не применяются)
        }

        this._indexManager.rebuildIndexesFromData(this.documents);

        this._checkpoint.startCheckpointTimer();

        this._lastCheckpointTimestamp = loaded.timestamp || null;
    }

    // --- AUTO TTL CLEANUP ---
    _startTtlCleanupTimer() {
        this._stopTtlCleanupTimer();
        this._ttlCleanupTimer = setInterval(() => {
            const removed = cleanupExpiredDocs(this.documents, this._indexManager);
            if (removed > 0) {
                console.log(`[WiseJSON] [TTL] Auto-cleanup: удалено ${removed} протухших документов (collection: ${this.name})`);
            }
        }, this._ttlCleanupIntervalMs);
    }

    _stopTtlCleanupTimer() {
        if (this._ttlCleanupTimer) {
            clearInterval(this._ttlCleanupTimer);
            this._ttlCleanupTimer = null;
        }
    }
    // --- END AUTO TTL CLEANUP ---

    async _enqueue(opFn) {
        return new Promise((resolve, reject) => {
            this._writeQueue.push({ opFn, resolve, reject });
            this._processQueue();
        });
    }

    async _processQueue() {
        if (this._writing || this._writeQueue.length === 0) return;

        this._writing = true;
        const task = this._writeQueue.shift();

        try {
            const result = await task.opFn();
            task.resolve(result);
        } catch (err) {
            task.reject(err);
        } finally {
            this._writing = false;
            this._processQueue();
        }
    }

    // === Обычные методы ===

    async insert(doc) {
        if (!isPlainObject(doc)) throw new Error('insert: аргумент должен быть объектом.');

        return this._enqueue(async () => {
            const _id = doc._id || this._idGenerator();
            const now = new Date().toISOString();
            const finalDoc = {
                ...doc,
                _id,
                createdAt: doc.createdAt || now,
                updatedAt: doc.updatedAt || now,
            };

            const result = await this._enqueueDataModification(
                { op: 'INSERT', doc: finalDoc },
                'INSERT',
                (_, inserted) => inserted
            );

            this._stats.inserts++;
            console.log(`[WiseJSON] Inserted document with _id: ${_id} in collection: ${this.name}`);
            return result;
        });
    }

    async insertMany(docs) {
        if (!Array.isArray(docs)) throw new Error('insertMany: Argument must be an array');
        const now = new Date().toISOString();
        const prepared = docs.map(doc => ({
            ...doc,
            _id: doc._id || this._idGenerator(),
            createdAt: doc.createdAt || now,
            updatedAt: doc.updatedAt || now,
        }));

        return this._enqueue(async () => {
            await this._enqueueDataModification(
                { op: 'BATCH_INSERT', docs: prepared },
                'BATCH_INSERT',
                (_, inserted) => inserted
            );
            this._stats.inserts += prepared.length;
            console.log(`[WiseJSON] Inserted ${prepared.length} documents in collection: ${this.name}`);
            return prepared;
        });
    }

    async update(id, updates) {
        if (!this.documents.has(id)) throw new Error(`update: документ с id "${id}" не найден.`);
        if (!isPlainObject(updates)) throw new Error('update: обновления должны быть объектом.');

        return this._enqueue(async () => {
            const now = new Date().toISOString();
            const result = await this._enqueueDataModification(
                { op: 'UPDATE', id, data: { ...updates, updatedAt: now } },
                'UPDATE',
                (prev, next) => next,
                { id }
            );
            this._stats.updates++;
            console.log(`[WiseJSON] Updated document with _id: ${id} in collection: ${this.name}`);
            return result;
        });
    }

    async remove(id) {
        if (!this.documents.has(id)) return false;

        return this._enqueue(async () => {
            const result = await this._enqueueDataModification(
                { op: 'REMOVE', id },
                'REMOVE',
                () => true,
                { id }
            );
            this._stats.removes++;
            console.log(`[WiseJSON] Removed document with _id: ${id} in collection: ${this.name}`);
            return result;
        });
    }

    async clear() {
        return this._enqueue(async () => {
            const result = await this._enqueueDataModification(
                { op: 'CLEAR' },
                'CLEAR',
                () => true
            );
            this.documents.clear();
            this._indexManager.clearAllData();
            this._stats.clears++;
            console.log(`[WiseJSON] Cleared all documents in collection: ${this.name}`);
            return result;
        });
    }

    async getById(id) {
        const doc = this.documents.get(id);
        return (doc && isAlive(doc)) ? doc : null;
    }

    async getAll() {
        cleanupExpiredDocs(this.documents, this._indexManager);
        return Array.from(this.documents.values()).filter(isAlive);
    }

    async count() {
        cleanupExpiredDocs(this.documents, this._indexManager);
        return Array.from(this.documents.values()).filter(isAlive).length;
    }

    async find(queryFn) {
        if (typeof queryFn !== 'function') throw new Error('find: требуется функция-предикат');
        cleanupExpiredDocs(this.documents, this._indexManager);
        return Array.from(this.documents.values()).filter(isAlive).filter(queryFn);
    }

    async findOne(queryFn) {
        if (typeof queryFn !== 'function') throw new Error('findOne: требуется функция-предикат');
        cleanupExpiredDocs(this.documents, this._indexManager);
        return Array.from(this.documents.values()).filter(isAlive).find(queryFn) || null;
    }

    async createIndex(fieldName, options) {
        this._indexManager.createIndex(fieldName, options);
        this._indexManager.rebuildIndexesFromData(this.documents);
        console.log(`[WiseJSON] Created index on field '${fieldName}' (collection: ${this.name})`);
    }

    async dropIndex(fieldName) {
        this._indexManager.dropIndex(fieldName);
        console.log(`[WiseJSON] Dropped index on field '${fieldName}' (collection: ${this.name})`);
    }

    async getIndexes() {
        return this._indexManager.getIndexesMeta();
    }

    async findOneByIndexedValue(fieldName, value) {
        cleanupExpiredDocs(this.documents, this._indexManager);
        const id = this._indexManager.findOneIdByIndex(fieldName, value);
        const doc = id ? this.documents.get(id) || null : null;
        return (doc && isAlive(doc)) ? doc : null;
    }

async findByIndexedValue(fieldName, value) {
    cleanupExpiredDocs(this.documents, this._indexManager);
    const idx = this._indexManager.indexes.get(fieldName);
    if (!idx) return [];
    if (idx.type === 'unique') {
        const id = this._indexManager.findOneIdByIndex(fieldName, value);
        const doc = id ? this.documents.get(id) : null;
        return doc && isAlive(doc) ? [doc] : [];
    }
    const ids = this._indexManager.findIdsByIndex(fieldName, value);
    return Array.from(ids)
        .map(id => this.documents.get(id))
        .filter(Boolean)
        .filter(isAlive);
}

    on(eventName, listener) {
        this._emitter.on(eventName, listener);
    }

    off(eventName, listener) {
        this._emitter.off(eventName, listener);
    }

    async flushToDisk() {
        cleanupExpiredDocs(this.documents, this._indexManager);
        const checkpointResult = await this._checkpoint.saveCheckpoint();
        let lastCheckpointTimestamp = null;
        if (checkpointResult && checkpointResult.metaFile) {
            const m = checkpointResult.metaFile.match(/checkpoint_meta_[^_]+_(.+)\.json/);
            if (m && m[1]) {
                lastCheckpointTimestamp = m[1].replace(/-/g, ':');
            }
        }
        this._lastCheckpointTimestamp = lastCheckpointTimestamp || new Date().toISOString();
        await compactWal(this.walPath, this._lastCheckpointTimestamp);

        console.log(`[WiseJSON] Saved checkpoint for collection: ${this.name}`);
        return checkpointResult;
    }

    async close() {
        this._checkpoint.stopCheckpointTimer();
        this._stopTtlCleanupTimer();
        await this.flushToDisk();
        console.log(`[WiseJSON] Closed collection: ${this.name} (checkpoint saved)`);
    }

    stats() {
        cleanupExpiredDocs(this.documents, this._indexManager);
        return {
            inserts: this._stats.inserts,
            updates: this._stats.updates,
            removes: this._stats.removes,
            clears: this._stats.clears,
            count: Array.from(this.documents.values()).filter(isAlive).length
        };
    }

    _setupGracefulShutdown() {
        if (Collection._hasGracefulShutdown) return;
        const signals = ['SIGINT', 'SIGTERM'];
        signals.forEach(signal => {
            process.on(signal, async () => {
                try {
                    console.log(`\n[WiseJSON] Получен сигнал ${signal}, сохраняем коллекцию "${this.name}"...`);
                    await this.close();
                } catch (e) {
                    console.error(`[WiseJSON] Ошибка при автосохранении коллекции "${this.name}" при завершении:`, e);
                }
            });
        });
        Collection._hasGracefulShutdown = true;
    }

    // === Транзакционные методы ===

    async _applyTransactionInsert(doc, txid) {
        // Не пишем в WAL — уже записано!
        const _id = doc._id || this._idGenerator();
        const now = new Date().toISOString();
        const finalDoc = {
            ...doc,
            _id,
            createdAt: doc.createdAt || now,
            updatedAt: doc.updatedAt || now,
            _txn: txid
        };
        this.documents.set(_id, finalDoc);
        this._indexManager.afterInsert(finalDoc);
        this._stats.inserts++;
        this._emitter.emit('insert', finalDoc);
        return finalDoc;
    }

    async _applyTransactionInsertMany(docs, txid) {
        const now = new Date().toISOString();
        for (const doc of docs) {
            const _id = doc._id || this._idGenerator();
            const finalDoc = {
                ...doc,
                _id,
                createdAt: doc.createdAt || now,
                updatedAt: doc.updatedAt || now,
                _txn: txid
            };
            this.documents.set(_id, finalDoc);
            this._indexManager.afterInsert(finalDoc);
            this._stats.inserts++;
            this._emitter.emit('insert', finalDoc);
        }
        return true;
    }

    async _applyTransactionUpdate(id, updates, txid) {
        const oldDoc = this.documents.get(id);
        if (!oldDoc) return null;
        const now = new Date().toISOString();
        const newDoc = {
            ...oldDoc,
            ...updates,
            updatedAt: now,
            _txn: txid
        };
        this.documents.set(id, newDoc);
        this._indexManager.afterUpdate(oldDoc, newDoc);
        this._stats.updates++;
        this._emitter.emit('update', newDoc, oldDoc);
        return newDoc;
    }

    async _applyTransactionRemove(id, txid) {
        const doc = this.documents.get(id);
        if (!doc) return false;
        this.documents.delete(id);
        this._indexManager.afterRemove(doc);
        this._stats.removes++;
        this._emitter.emit('remove', doc);
        return true;
    }

    async _applyTransactionClear(txid) {
        for (const doc of this.documents.values()) {
            this._indexManager.afterRemove(doc);
        }
        this.documents.clear();
        this._indexManager.clearAllData();
        this._stats.clears++;
        this._emitter.emit('clear');
        return true;
    }

    // Применение операции из транзакционного WAL при восстановлении
    async _applyTransactionWalOp(entry) {
        // entry: {txn:'op', col, type, args, ...}
        switch (entry.type) {
            case 'insert':
                await this._applyTransactionInsert(entry.args[0], entry.txid);
                break;
            case 'insertMany':
                await this._applyTransactionInsertMany(entry.args[0], entry.txid);
                break;
            case 'update':
                await this._applyTransactionUpdate(entry.args[0], entry.args[1], entry.txid);
                break;
            case 'remove':
                await this._applyTransactionRemove(entry.args[0], entry.txid);
                break;
            case 'clear':
                await this._applyTransactionClear(entry.txid);
                break;
        }
    }
}

module.exports = Collection;
