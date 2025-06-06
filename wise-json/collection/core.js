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
const { acquireCollectionLock, releaseCollectionLock } = require('./file-lock.js');
const { createWriteQueue } = require('./queue.js');
const ops = require('./ops.js');

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

        this._releaseLock = null;

        // Очередь записи
        createWriteQueue(this);

        // Для isPlainObject проверки в ops
        this.isPlainObject = isPlainObject;

        // Привязка всех операций из ops.js
        this.insert = ops.insert.bind(this);
        this.insertMany = ops.insertMany.bind(this);
        this.insertManyBatch = ops.insertManyBatch.bind(this);
        this.update = ops.update.bind(this);
        this.updateMany = ops.updateMany.bind(this);
        this.updateManyBatch = ops.updateManyBatch.bind(this);
        this.remove = ops.remove.bind(this);
        this.clear = ops.clear.bind(this);
    }

    async _acquireLock() {
        if (this._releaseLock) return;
        this._releaseLock = await acquireCollectionLock(this.collectionDirPath);
    }
    async _releaseLockIfHeld() {
        if (this._releaseLock) {
            await releaseCollectionLock(this._releaseLock);
            this._releaseLock = null;
        }
    }

    async _initialize() {
        await fs.mkdir(this.collectionDirPath, { recursive: true });
        await initializeWal(this.walPath, this.collectionDirPath);

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

        const walEntries = await readWal(this.walPath, loaded.timestamp);
        if (walEntries.length > 0) {
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
        console.log(`[WiseJSON] Exported ${docs.length} documents to ${filePath}`);
    }

    async exportCsv(filePath) {
        const { flattenDocToCsv } = require('../../explorer/utils.js');
        const docs = await this.getAll();
        if (docs.length === 0) {
            await fs.writeFile(filePath, '', 'utf8');
            console.log(`[WiseJSON] No documents to export in CSV.`);
            return;
        }
        const csv = flattenDocToCsv(docs);
        await fs.writeFile(filePath, csv, 'utf8');
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
