// wise-json/collection/core.js

const path = require('path');
const fs = require('fs/promises');
const fssync = require('fs');
const { createWriteStream } = require('fs');
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

/**
 * Коллекция WiseJSON.
 * @class
 */
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

        this._lastCheckpointTimestamp = null;

        this._ttlCleanupIntervalMs = this.options.ttlCleanupIntervalMs || 60 * 1000;
        this._ttlCleanupTimer = null;
        this._startTtlCleanupTimer();
    }

    async _initialize() {
        await fs.mkdir(this.collectionDirPath, { recursive: true });
        await initializeWal(this.walPath, this.collectionDirPath);

        const loaded = await loadLatestCheckpoint(
            path.join(this.collectionDirPath, '_checkpoints'),
            this.name
        );

        if (loaded && loaded.documents && loaded.documents.size > 0) {
            // TODO: Перевести console.log на кастомный логгер через options.logger
            console.log(`[WiseJSON] ✅ Checkpoint loaded: ${loaded.documents.size} documents (collection: ${this.name})`);
        } else {
            // TODO: Перевести console.warn на кастомный логгер через options.logger
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
                // TODO: Перевести console.warn на кастомный логгер через options.logger
                console.warn(`[WiseJSON] ⚠ Failed to restore index '${indexMeta.fieldName}': ${e.message}`);
            }
        }

        const walEntries = await readWal(this.walPath, loaded.timestamp);
        if (walEntries.length > 0) {
            // TODO: Перевести console.log на кастомный логгер через options.logger
            console.log(`[WiseJSON] 📝 Applying ${walEntries.length} WAL entries for collection: ${this.name}`);
        }
        for (const entry of walEntries) {
            if (entry.txn === 'op' && entry._txn_applied) {
                await this._applyTransactionWalOp(entry);
            } else if (!entry.txn) {
                this.applyWalEntryToMemory(entry, false);
            }
        }

        this._indexManager.rebuildIndexesFromData(this.documents);
        this._checkpoint.startCheckpointTimer();
        this._lastCheckpointTimestamp = loaded.timestamp || null;
    }

    _startTtlCleanupTimer() {
        this._stopTtlCleanupTimer();
        this._ttlCleanupTimer = setInterval(() => {
            const removed = cleanupExpiredDocs(this.documents, this._indexManager);
            if (removed > 0) {
                // TODO: Перевести console.log на кастомный логгер через options.logger
                console.log(`[WiseJSON] [TTL] Auto-cleanup: удалено ${removed} документов (collection: ${this.name})`);
            }
        }, this._ttlCleanupIntervalMs);
    }

    _stopTtlCleanupTimer() {
        if (this._ttlCleanupTimer) {
            clearInterval(this._ttlCleanupTimer);
            this._ttlCleanupTimer = null;
        }
    }

    /**
     * Последовательная очередь записи.
     * ASSUMPTION: Все операции записи сериализуются через _writeQueue и выполняются только по одной.
     * Это гарантирует отсутствие race conditions и согласованность данных для single-process mode.
     * При работе нескольких процессов/инстансов одновременная запись не поддерживается (может привести к порче данных).
     * Для поддержки многопроцессной архитектуры потребуется другая схема синхронизации.
     */
    async _enqueue(opFn) {
        return new Promise((resolve, reject) => {
            this._writeQueue.push({ opFn, resolve, reject });
            this._processQueue();
        });
    }

    async _processQueue() {
        // ASSUMPTION: Одновременная обработка только одной записи из очереди.
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

    async insert(doc) {
        if (!isPlainObject(doc)) throw new Error('insert: аргумент должен быть объектом.');
        return this._enqueue(async () => {
            const _id = doc._id || this._idGenerator();
            const now = new Date().toISOString();
            const finalDoc = { ...doc, _id, createdAt: now, updatedAt: now };
            const result = await this._enqueueDataModification(
                { op: 'INSERT', doc: finalDoc },
                'INSERT',
                (_, inserted) => inserted
            );
            this._stats.inserts++;
            // TODO: Перевести console.log на кастомный логгер через options.logger
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
            createdAt: now,
            updatedAt: now
        }));
        return this._enqueue(async () => {
            await this._enqueueDataModification(
                { op: 'BATCH_INSERT', docs: prepared },
                'BATCH_INSERT',
                (_, inserted) => inserted
            );
            this._stats.inserts += prepared.length;
            // TODO: Перевести console.log на кастомный логгер через options.logger
            console.log(`[WiseJSON] Inserted ${prepared.length} documents in collection: ${this.name}`);
            return prepared;
        });
    }

    async insertManyBatch(docs) {
        return this.insertMany(docs);
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
            // TODO: Перевести console.log на кастомный логгер через options.logger
            console.log(`[WiseJSON] Updated document with _id: ${id} in collection: ${this.name}`);
            return result;
        });
    }

    async updateMany(queryFn, updates) {
        let count = 0;
        for (const [id, doc] of this.documents.entries()) {
            if (typeof queryFn === 'function' ? queryFn(doc) : false) {
                await this.update(id, updates);
                count++;
            }
        }
        return count;
    }

    async updateManyBatch(queryFn, updates) {
        return this.updateMany(queryFn, updates);
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
            // TODO: Перевести console.log на кастомный логгер через options.logger
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
            // TODO: Перевести console.log на кастомный логгер через options.logger
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
        // TODO: Перевести console.log на кастомный логгер через options.logger
        console.log(`[WiseJSON] Created index on field '${fieldName}' (collection: ${this.name})`);
    }

    async dropIndex(fieldName) {
        this._indexManager.dropIndex(fieldName);
        // TODO: Перевести console.log на кастомный логгер через options.logger
        console.log(`[WiseJSON] Dropped index on field '${fieldName}' (collection: ${this.name})`);
    }

    async getIndexes() {
        return this._indexManager.getIndexesMeta();
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

    async findOneByIndexedValue(fieldName, value) {
        const results = await this.findByIndexedValue(fieldName, value);
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Экспорт коллекции в JSON-файл.
     * @param {string} filePath
     * @param {object} options
     * @returns {Promise<void>}
     */
    async exportJson(filePath, options = {}) {
        const docs = await this.getAll();
        const stream = createWriteStream(filePath, { encoding: 'utf8' });
        stream.write('[');
        for (let i = 0; i < docs.length; i++) {
            const json = JSON.stringify(docs[i]);
            stream.write(json);
            if (i < docs.length - 1) {
                stream.write(',\n');
            }
        }
        stream.write(']');
        stream.end();
        // TODO: Перевести console.log на кастомный логгер через options.logger
        console.log(`[WiseJSON] Exported ${docs.length} documents to ${filePath}`);
    }

    /**
     * Экспорт коллекции в CSV-файл.
     * FIXME: Зависимость от explorer/utils.js (flattenDocToCsv). Лучше перенести функцию в ядро или общий utils.
     * @param {string} filePath
     * @returns {Promise<void>}
     */
    async exportCsv(filePath) {
        // FIXME: Зависимость на explorer/utils.js, нужно перенести flattenDocToCsv в ядро
        const { flattenDocToCsv } = require('../../explorer/utils.js');
        const docs = await this.getAll();
        if (docs.length === 0) {
            await fs.writeFile(filePath, '', 'utf8');
            // TODO: Перевести console.log на кастомный логгер через options.logger
            console.log(`[WiseJSON] No documents to export in CSV.`);
            return;
        }
        const csv = flattenDocToCsv(docs);
        await fs.writeFile(filePath, csv, 'utf8');
        // TODO: Перевести console.log на кастомный логгер через options.logger
        console.log(`[WiseJSON] Exported ${docs.length} documents to ${filePath} (CSV)`);
    }

    async importJson(filePath, options = {}) {
        const mode = options.mode || 'append';
        const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (!Array.isArray(data)) {
            throw new Error(`Import file must contain JSON array`);
        }
        if (mode === 'replace') {
            await this.clear();
        }
        await this.insertMany(data);
        // TODO: Перевести console.log на кастомный логгер через options.logger
        console.log(`[WiseJSON] Imported ${data.length} documents from ${filePath} (mode: ${mode})`);
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
        if (checkpointResult && checkpointResult.meta && checkpointResult.meta.timestamp) {
            lastCheckpointTimestamp = checkpointResult.meta.timestamp;
        }
        this._lastCheckpointTimestamp = lastCheckpointTimestamp || new Date().toISOString();
        await compactWal(this.walPath, this._lastCheckpointTimestamp);
        // TODO: Перевести console.log на кастомный логгер через options.logger
        console.log(`[WiseJSON] Saved checkpoint for collection: ${this.name}`);
        return checkpointResult;
    }

    async close() {
        this._checkpoint.stopCheckpointTimer();
        this._stopTtlCleanupTimer();
        await this.flushToDisk();
        // TODO: Перевести console.log на кастомный логгер через options.logger
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

    async _applyTransactionWalOp(entry) {
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

    async _applyTransactionInsert(doc, txid) {
        const _id = doc._id || this._idGenerator();
        const now = new Date().toISOString();
        const finalDoc = { ...doc, _id, createdAt: doc.createdAt || now, updatedAt: doc.updatedAt || now, _txn: txid };
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
            const finalDoc = { ...doc, _id, createdAt: doc.createdAt || now, updatedAt: doc.updatedAt || now, _txn: txid };
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
        const newDoc = { ...oldDoc, ...updates, updatedAt: now, _txn: txid };
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
}

module.exports = Collection;
