const path = require('path');
const fs = require('fs/promises');

const CollectionEventEmitter = require('./events.js');
const createWalOps = require('./wal-ops.js');
const IndexManager = require('./indexes.js');
const createCheckpointController = require('./checkpoints.js');

const { defaultIdGenerator, isNonEmptyString, isPlainObject } = require('./utils.js');
const { initializeWal, readWal, getWalPath } = require('../wal-manager.js');
const { loadLatestCheckpoint } = require('../checkpoint-manager.js');

class Collection {
    constructor(name, dbRootPath, options = {}) {
        if (!isNonEmptyString(name)) {
            throw new Error('Collection: имя коллекции должно быть непустой строкой.');
        }

        this.name = name;
        this.options = options;
        this.dbRootPath = dbRootPath;
        this.collectionDirPath = path.join(dbRootPath, name);

        this.documents = new Map();
        this._idGenerator = typeof options.idGenerator === 'function' ? options.idGenerator : defaultIdGenerator;
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
            _triggerCheckpointIfRequired: op => this._checkpoint.incrementWalOpsAndMaybeTrigger(op),
            options: this.options,
            walPath: this.walPath,
        });

        this.applyWalEntryToMemory = walOps.applyWalEntryToMemory;
        this._enqueueDataModification = walOps.enqueueDataModification;

        // --- Добавляем счетчики статистики ---
        this._stats = { inserts: 0, updates: 0, removes: 0, clears: 0 };

        this.initPromise = this._initialize();
    }

    async _initialize() {
        await fs.mkdir(this.collectionDirPath, { recursive: true });
        await initializeWal(this.walPath, this.collectionDirPath);

        const loaded = await loadLatestCheckpoint(
            path.join(this.collectionDirPath, '_checkpoints'),
            this.name
        );

        for (const [id, doc] of loaded.documents.entries()) {
            this.documents.set(id, doc);
        }

        for (const indexMeta of loaded.indexesMeta) {
            this._indexManager.createIndex(indexMeta.fieldName, {
                unique: indexMeta.type === 'unique',
            });
        }

        this._indexManager.rebuildIndexesFromData(this.documents);

        const walEntries = await readWal(this.walPath, loaded.timestamp);
        for (const entry of walEntries) {
            this.applyWalEntryToMemory(entry, false);
        }

        this._checkpoint.startCheckpointTimer();
    }

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
            return result;
        });
    }

    // --------- Новый метод пакетной вставки ----------
    async insertMany(docs) {
        if (!Array.isArray(docs)) throw new Error('insertMany: Argument must be an array');
        const results = [];
        for (const doc of docs) {
            results.push(await this.insert(doc));
        }
        return results;
    }
    // ------------------------------------------------

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
            return result;
        });
    }

    async getById(id) {
        return this.documents.get(id) || null;
    }

    async getAll() {
        return Array.from(this.documents.values());
    }

    async count() {
        return this.documents.size;
    }

    async find(queryFn) {
        if (typeof queryFn !== 'function') throw new Error('find: требуется функция-предикат');
        return Array.from(this.documents.values()).filter(queryFn);
    }

    async findOne(queryFn) {
        if (typeof queryFn !== 'function') throw new Error('findOne: требуется функция-предикат');
        return Array.from(this.documents.values()).find(queryFn) || null;
    }

    async createIndex(fieldName, options) {
        this._indexManager.createIndex(fieldName, options);
        this._indexManager.rebuildIndexesFromData(this.documents);
    }

    async dropIndex(fieldName) {
        this._indexManager.dropIndex(fieldName);
    }

    async getIndexes() {
        return this._indexManager.getIndexesMeta();
    }

    async findOneByIndexedValue(fieldName, value) {
        const id = this._indexManager.findOneIdByIndex(fieldName, value);
        return id ? this.documents.get(id) || null : null;
    }

    async findByIndexedValue(fieldName, value) {
        const ids = this._indexManager.findIdsByIndex(fieldName, value);
        return Array.from(ids).map(id => this.documents.get(id)).filter(Boolean);
    }

    on(eventName, listener) {
        this._emitter.on(eventName, listener);
    }

    off(eventName, listener) {
        this._emitter.off(eventName, listener);
    }

    async flushToDisk() {
        return this._checkpoint.saveCheckpoint();
    }

    async close() {
        this._checkpoint.stopCheckpointTimer();
        await this.flushToDisk();
    }

    // ------ Публичная статистика ------
    stats() {
        return {
            inserts: this._stats.inserts,
            updates: this._stats.updates,
            removes: this._stats.removes,
            clears: this._stats.clears,
            count: this.documents.size
        };
    }
    // ----------------------------------
}

module.exports = Collection;
