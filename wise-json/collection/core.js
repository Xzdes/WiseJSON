// wise-json/collection/core.js

const path = require('path');
const fs = require('fs/promises');
const CollectionEventEmitter = require('./events.js');
const IndexManager = require('./indexes.js');
const logger = require('../logger');
const createCheckpointController = require('./checkpoints.js'); 
const {
  defaultIdGenerator,
  isNonEmptyString,
  isPlainObject, 
  makeAbsolutePath,
} = require('./utils.js');
const {
  initializeWal,
  readWal,
  getWalPath,
  compactWal,
} = require('../wal-manager.js'); 
const {
  loadLatestCheckpoint, 
  cleanupOldCheckpoints 
} = require('../checkpoint-manager.js'); 
const {
  cleanupExpiredDocs, 
  isAlive 
} = require('./ttl.js'); 
const {
  acquireCollectionLock, 
  releaseCollectionLock 
} = require('./file-lock.js'); 
const { createWriteQueue } = require('./queue.js');

const crudOps = require('./ops.js');
const queryOps = require('./query-ops.js');
const dataExchangeOps = require('./data-exchange.js');

function validateCollectionOptions(opts = {}) {
    const defaults = {
        maxSegmentSizeBytes: 2 * 1024 * 1024, 
        checkpointIntervalMs: 5 * 60 * 1000,  
        ttlCleanupIntervalMs: 60 * 1000,      
        idGenerator: defaultIdGenerator, 
        checkpointsToKeep: 5,
        maxWalEntriesBeforeCheckpoint: 1000, 
        walReadOptions: { recover: false, strict: false } 
    };
    const options = { ...defaults, ...opts };

    if (typeof options.maxSegmentSizeBytes !== 'number' || options.maxSegmentSizeBytes <= 0) options.maxSegmentSizeBytes = defaults.maxSegmentSizeBytes;
    if (typeof options.checkpointIntervalMs !== 'number' || options.checkpointIntervalMs < 0) options.checkpointIntervalMs = defaults.checkpointIntervalMs;
    if (typeof options.ttlCleanupIntervalMs !== 'number' || options.ttlCleanupIntervalMs <= 0) options.ttlCleanupIntervalMs = defaults.ttlCleanupIntervalMs;
    if (typeof options.idGenerator !== 'function') options.idGenerator = defaults.idGenerator;
    if (typeof options.checkpointsToKeep !== 'number' || options.checkpointsToKeep < 1) options.checkpointsToKeep = defaults.checkpointsToKeep;
    if (typeof options.maxWalEntriesBeforeCheckpoint !== 'number' || options.maxWalEntriesBeforeCheckpoint < 0) options.maxWalEntriesBeforeCheckpoint = defaults.maxWalEntriesBeforeCheckpoint;
    
    if (typeof options.walReadOptions !== 'object' || options.walReadOptions === null) {
        options.walReadOptions = { ...defaults.walReadOptions };
    } else {
        options.walReadOptions = { ...defaults.walReadOptions, ...options.walReadOptions };
    }
    return options;
}


class Collection {
  constructor(name, dbRootPath, options = {}) {
    if (!isNonEmptyString(name)) {
      throw new Error('Collection: имя коллекции должно быть непустой строкой.');
    }

    this.name = name;
    this.dbRootPath = makeAbsolutePath(dbRootPath);
    this.options = validateCollectionOptions(options); 
    
    this.collectionDirPath = path.resolve(this.dbRootPath, this.name);
    this.checkpointsDir = path.join(this.collectionDirPath, '_checkpoints');

    this.walPath = getWalPath(this.collectionDirPath, this.name); 
    
    this.documents = new Map();
    this._idGenerator = this.options.idGenerator; 
    this.isPlainObject = isPlainObject; 

    this._emitter = new CollectionEventEmitter(this.name);
    this._indexManager = new IndexManager(this.name);
    
    this._checkpoint = createCheckpointController({
      collectionName: this.name,
      collectionDirPath: this.collectionDirPath, 
      documents: this.documents,
      options: this.options,
      getIndexesMeta: () => this._indexManager.getIndexesMeta(),
    });

    this._stats = { 
        inserts: 0, 
        updates: 0, 
        removes: 0, 
        clears: 0, 
        walEntriesSinceCheckpoint: 0 
    };

    this._lastCheckpointTimestamp = null;
    this._checkpointTimerId = null;
    this._ttlCleanupTimer = null;
    this._releaseLock = null; 

    createWriteQueue(this);

    // --- Привязка методов к экземпляру ---
    
    // CRUD операции
    this.insert = crudOps.insert.bind(this);
    this.insertMany = crudOps.insertMany.bind(this);
    this.update = crudOps.update.bind(this);
    this.remove = crudOps.remove.bind(this);
    this.removeMany = crudOps.removeMany.bind(this);
    this.clear = crudOps.clear.bind(this);

    // Базовые методы запросов
    this.getById = queryOps.getById.bind(this);
    this.getAll = queryOps.getAll.bind(this);
    this.count = queryOps.count.bind(this);
    this.find = queryOps.find.bind(this);
    this.findOne = queryOps.findOne.bind(this);

    // Старые методы запросов по индексам (для обратной совместимости)
    this.findByIndexedValue = queryOps.findByIndexedValue.bind(this);
    this.findOneByIndexedValue = queryOps.findOneByIndexedValue.bind(this);

    // НОВЫЕ РАСШИРЕННЫЕ МЕТОДЫ
    this.updateOne = queryOps.updateOne.bind(this);
    this.updateMany = queryOps.updateMany.bind(this); // Переопределяем старый метод на новый, более мощный
    this.findOneAndUpdate = queryOps.findOneAndUpdate.bind(this);
    this.deleteOne = queryOps.deleteOne.bind(this);
    this.deleteMany = queryOps.deleteMany.bind(this);

    // Импорт/Экспорт
    this.exportJson = dataExchangeOps.exportJson.bind(this);
    this.exportCsv = dataExchangeOps.exportCsv.bind(this);
    this.importJson = dataExchangeOps.importJson.bind(this);
    
    this.initPromise = this._initialize();
  }
  
  _applyWalEntryToMemory(entry, emitEvents = true) {
    if (entry.op === 'INSERT') {
        const doc = entry.doc;
        if (doc) { 
            this.documents.set(doc._id, doc);
            this._indexManager.afterInsert(doc);
            if (emitEvents) this._emitter.emit('insert', doc);
        }
    } else if (entry.op === 'BATCH_INSERT') {
        const docs = Array.isArray(entry.docs) ? entry.docs : [];
        for (const doc of docs) {
            if (doc) { 
                this.documents.set(doc._id, doc);
                this._indexManager.afterInsert(doc);
                if (emitEvents) this._emitter.emit('insert', doc);
            }
        }
    } else if (entry.op === 'UPDATE') {
        const id = entry.id;
        const prevDoc = this.documents.get(id); 
        if (prevDoc && isAlive(prevDoc)) { 
            const updatedDoc = { ...prevDoc, ...entry.data };
            this.documents.set(id, updatedDoc);
            this._indexManager.afterUpdate(prevDoc, updatedDoc);
            if (emitEvents) this._emitter.emit('update', updatedDoc, prevDoc);
        }
    } else if (entry.op === 'REMOVE') {
        const id = entry.id;
        const prevDoc = this.documents.get(id);
        if (prevDoc) { 
            this.documents.delete(id);
            this._indexManager.afterRemove(prevDoc);
            if (emitEvents) this._emitter.emit('remove', prevDoc);
        }
    } else if (entry.op === 'CLEAR') {
        const allDocs = Array.from(this.documents.values()); 
        this.documents.clear(); 
        for (const doc of allDocs) {
            this._indexManager.afterRemove(doc);
        }
        this._indexManager.clearAllData(); 
        if (emitEvents) this._emitter.emit('clear');
    }
  }

  async _enqueueDataModification(entry, opType, getResultFn, extra = {}) {
    if (this._indexManager) {
        if (opType === 'INSERT') {
            const docToInsert = entry.doc;
            if (docToInsert) {
                const uniqueIndexesMeta = (this._indexManager.getIndexesMeta() || []).filter(m => m.type === 'unique');
                for (const idxMeta of uniqueIndexesMeta) {
                    const fieldName = idxMeta.fieldName;
                    const valueToInsert = docToInsert[fieldName];
                    if (valueToInsert !== undefined && valueToInsert !== null) {
                        const index = this._indexManager.indexes.get(fieldName);
                        if (index && index.data && index.data.has(valueToInsert)) {
                            if (index.data.get(valueToInsert) !== docToInsert._id) { 
                                throw new Error(`Duplicate value '${valueToInsert}' for unique index '${fieldName}' in insert operation`);
                            }
                        }
                    }
                }
            }
        } else if (opType === 'BATCH_INSERT') {
            const docs = entry.docs || [];
            if (docs.length > 0) {
                const uniqueIndexesMeta = (this._indexManager.getIndexesMeta() || []).filter(meta => meta.type === 'unique').map(meta => meta.fieldName);
                for (const field of uniqueIndexesMeta) {
                    const batchValues = new Set();
                    const existingValuesFromMemory = new Set();
                    for (const doc of this.documents.values()) {
                        if (doc[field] !== undefined && doc[field] !== null) existingValuesFromMemory.add(doc[field]);
                    }
                    for (const doc of docs) {
                        if (doc[field] !== undefined && doc[field] !== null) {
                            if (batchValues.has(doc[field]) || existingValuesFromMemory.has(doc[field])) {
                                throw new Error(`Duplicate value '${doc[field]}' for unique index '${field}' in batch insert`);
                            }
                            batchValues.add(doc[field]);
                        }
                    }
                }
            }
        } else if (opType === 'UPDATE') { 
            const docId = entry.id;
            const updates = entry.data;
            const originalDoc = this.documents.get(docId);
            if (originalDoc && updates) { 
                const uniqueIndexesMeta = (this._indexManager.getIndexesMeta() || []).filter(m => m.type === 'unique');
                for (const idxMeta of uniqueIndexesMeta) {
                    const fieldName = idxMeta.fieldName;
                    if (updates.hasOwnProperty(fieldName)) {
                        const newValue = updates[fieldName];
                        const oldValue = originalDoc[fieldName];
                        if (newValue !== oldValue && newValue !== undefined && newValue !== null) {
                            const index = this._indexManager.indexes.get(fieldName);
                            if (index && index.data && index.data.has(newValue) && index.data.get(newValue) !== docId) {
                                throw new Error(`Duplicate value '${newValue}' for unique index '${fieldName}' in update operation for document '${docId}'`);
                            }
                        }
                    }
                }
            }
        }
    }
    
    await require('../wal-manager.js').appendWalEntry(this.walPath, entry);

    this._applyWalEntryToMemory(entry, true); 
    this._handlePotentialCheckpointTrigger();
    
    let nextResult = undefined;
    if (opType === 'INSERT') nextResult = entry.doc;
    else if (opType === 'BATCH_INSERT') nextResult = entry.docs;
    else if (opType === 'UPDATE') nextResult = this.documents.get(entry.id); 

    return getResultFn ? getResultFn(undefined, nextResult) : undefined;
  }

  async _initialize() {
    await fs.mkdir(this.collectionDirPath, { recursive: true });
    await fs.mkdir(this.checkpointsDir, { recursive: true }); 
    
    await initializeWal(this.walPath, this.collectionDirPath);

    const loadedCheckpoint = await loadLatestCheckpoint(this.checkpointsDir, this.name);

    for (const [id, doc] of loadedCheckpoint.documents.entries()) {
        this.documents.set(id, doc);
    }
    for (const indexMeta of loadedCheckpoint.indexesMeta || []) {
        try {
            this._indexManager.createIndex(indexMeta.fieldName, { unique: indexMeta.type === 'unique' });
        } catch (e) { /* ignore */ }
    }
    
    const walReadOptsWithLoadFlag = {...this.options.walReadOptions, isInitialLoad: true };
    const walEntries = await readWal(this.walPath, loadedCheckpoint.timestamp, walReadOptsWithLoadFlag);
    
    for (const entry of walEntries) {
      if (entry.txn === 'op' && entry._txn_applied_from_wal) { 
        await this._applyTransactionWalOp(entry);
      } else if (!entry.txn) { 
        this._applyWalEntryToMemory(entry, false); 
      }
    }

    this._stats.walEntriesSinceCheckpoint = 0; 
    this._indexManager.rebuildIndexesFromData(this.documents); 
    
    this._startCheckpointTimer();
    this._startTtlCleanupTimer();
    this._lastCheckpointTimestamp = loadedCheckpoint.timestamp || null;
    this._emitter.emit('initialized');
    return true; 
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

  _startCheckpointTimer() {
    this.stopCheckpointTimer(); 
    if (this.options.checkpointIntervalMs > 0) {
        this._checkpointTimerId = setInterval(async () => {
            try {
                await this.flushToDisk();
            } catch (e) {
                logger.error(`[Collection] Ошибка авто-чекпоинта для ${this.name}: ${e.message}`, e.stack);
            }
        }, this.options.checkpointIntervalMs);
    }
  }

  stopCheckpointTimer() {
    if (this._checkpointTimerId) {
      clearInterval(this._checkpointTimerId);
      this._checkpointTimerId = null;
    }
  }

  _startTtlCleanupTimer() {
    this._stopTtlCleanupTimer(); 
    if (this.options.ttlCleanupIntervalMs > 0) {
        this._ttlCleanupTimer = setInterval(() => {
            try {
                cleanupExpiredDocs(this.documents, this._indexManager);
            } catch (e) {
                logger.error(`[Collection] [TTL] Ошибка авто-очистки TTL для ${this.name}: ${e.message}`, e.stack);
            }
        }, this.options.ttlCleanupIntervalMs);
    }
  }

  _stopTtlCleanupTimer() {
    if (this._ttlCleanupTimer) {
      clearInterval(this._ttlCleanupTimer);
      this._ttlCleanupTimer = null;
    }
  }
  
  _handlePotentialCheckpointTrigger() { 
    this._stats.walEntriesSinceCheckpoint++;
    if (this.options.maxWalEntriesBeforeCheckpoint > 0 &&
        this._stats.walEntriesSinceCheckpoint >= this.options.maxWalEntriesBeforeCheckpoint) {
        this.flushToDisk().catch(e => { 
            logger.error(`[Collection] Ошибка авто-чекпоинта (по кол-ву WAL) для ${this.name}: ${e.message}`, e.stack);
        });
    }
  }

  async flushToDisk() {
    await this._acquireLock();
    try {
        cleanupExpiredDocs(this.documents, this._indexManager); 
        const checkpointResult = await this._checkpoint.saveCheckpoint(); 
        
        let newTimestamp = null;
        if (checkpointResult && checkpointResult.meta && checkpointResult.meta.timestamp) {
            newTimestamp = checkpointResult.meta.timestamp;
        }
        this._lastCheckpointTimestamp = newTimestamp || new Date().toISOString();
        this._stats.walEntriesSinceCheckpoint = 0; 

        await compactWal(this.walPath, this._lastCheckpointTimestamp); 
        
        if (this.options.checkpointsToKeep > 0) {
            await cleanupOldCheckpoints(this.checkpointsDir, this.name, this.options.checkpointsToKeep);
        }
        return checkpointResult;
    } finally {
        await this._releaseLockIfHeld();
    }
  }

  async close() {
    this.stopCheckpointTimer();
    this._stopTtlCleanupTimer();
    await this.flushToDisk(); 
  }

  stats() {
    cleanupExpiredDocs(this.documents, this._indexManager); 
    return {
      inserts: this._stats.inserts,
      updates: this._stats.updates,
      removes: this._stats.removes,
      clears: this._stats.clears,
      count: this.documents.size, 
      walEntriesSinceCheckpoint: this._stats.walEntriesSinceCheckpoint,
    };
  }

  async createIndex(fieldName, options = {}) {
    return this._enqueue(async () => { 
        this._indexManager.createIndex(fieldName, options);
        this._indexManager.rebuildIndexesFromData(this.documents);
        await this.flushToDisk();
    });
  }

  async dropIndex(fieldName) {
    return this._enqueue(async () => {
        this._indexManager.dropIndex(fieldName);
        await this.flushToDisk();
    });
  }

  async getIndexes() {
    return this._indexManager.getIndexesMeta(); 
  }

  on(eventName, listener) {
    this._emitter.on(eventName, listener);
  }

  off(eventName, listener) {
    this._emitter.off(eventName, listener);
  }

  async _applyTransactionWalOp(entry) {
    const txidForLog = entry.txid || entry.id || 'unknown_txid';
    switch (entry.type) {
      case 'insert': await this._applyTransactionInsert(entry.args[0], txidForLog); break;
      case 'insertMany': await this._applyTransactionInsertMany(entry.args[0], txidForLog); break;
      case 'update': await this._applyTransactionUpdate(entry.args[0], entry.args[1], txidForLog); break;
      case 'remove': await this._applyTransactionRemove(entry.args[0], txidForLog); break;
      case 'clear': await this._applyTransactionClear(txidForLog); break;
      default: logger.warn(`[Collection] Неизвестный тип транзакционной WAL-операции '${entry.type}' для ${this.name}, txid: ${txidForLog}`);
    }
  }
  async _applyTransactionInsert(docData, txid) {
    const _id = docData._id || this._idGenerator();
    const now = new Date().toISOString();
    const finalDoc = { ...docData, _id, createdAt: docData.createdAt || now, updatedAt: docData.updatedAt || now, _txn: txid };
    this.documents.set(_id, finalDoc);
    this._indexManager.afterInsert(finalDoc);
    this._stats.inserts++;
    this._emitter.emit('insert', finalDoc);
    return finalDoc;
  }
  async _applyTransactionInsertMany(docsData, txid) {
    const now = new Date().toISOString();
    const insertedDocs = [];
    for (const docData of docsData) {
      const _id = docData._id || this._idGenerator();
      const finalDoc = { ...docData, _id, createdAt: docData.createdAt || now, updatedAt: docData.updatedAt || now, _txn: txid };
      this.documents.set(_id, finalDoc);
      this._indexManager.afterInsert(finalDoc);
      this._stats.inserts++;
      this._emitter.emit('insert', finalDoc);
      insertedDocs.push(finalDoc);
    }
    return insertedDocs;
  }
  async _applyTransactionUpdate(id, updates, txid) {
    const oldDoc = this.documents.get(id);
    if (!oldDoc) return null;
    const { _id, createdAt, _txn, ...restOfUpdates } = updates; 
    const now = new Date().toISOString();
    const newDoc = { ...oldDoc, ...restOfUpdates, updatedAt: updates.updatedAt || now, _txn: txid }; 
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
    const allDocs = Array.from(this.documents.values());
    this.documents.clear();
    for (const doc of allDocs) {
      this._indexManager.afterRemove(doc);
    }
    this._indexManager.clearAllData(); 
    this._stats.clears++;
    this._stats.inserts = 0; this._stats.updates = 0; this._stats.removes = 0;
    this._stats.walEntriesSinceCheckpoint = 0;
    this._emitter.emit('clear');
    return true;
  }
}

module.exports = Collection;