// wise-json/collection/core.js

const path = require('path');
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');
const CollectionEventEmitter = require('./events.js');
const IndexManager = require('./indexes.js');
const SyncManager = require('../sync/sync-manager.js');
const { UniqueConstraintError } = require('../errors.js');
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
  appendWalEntry,
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
const { writeJsonFileSafe } = require('../storage-utils.js');

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
      throw new Error('Collection: collection name must be a non-empty string.');
    }

    this.name = name;
    this.dbRootPath = makeAbsolutePath(dbRootPath);
    this.options = validateCollectionOptions(options);

    this.logger = this.options.logger || require('../logger');

    this.collectionDirPath = path.resolve(this.dbRootPath, this.name);
    this.checkpointsDir = path.join(this.collectionDirPath, '_checkpoints');
    this.walPath = getWalPath(this.collectionDirPath, this.name);
    this.quarantinePath = path.join(this.collectionDirPath, `quarantine_${this.name}.log`);

    this.documents = new Map();
    this._idGenerator = this.options.idGenerator;
    this.isPlainObject = isPlainObject;

    this._emitter = new CollectionEventEmitter(this.name);
    this._indexManager = new IndexManager(this.name, this.logger);

    this._stats = {
        inserts: 0,
        updates: 0,
        removes: 0,
        clears: 0,
        walEntriesSinceCheckpoint: 0,
        lastCheckpointTimestamp: null
    };

    this._checkpointTimerId = null;
    this._ttlCleanupTimer = null;
    this._releaseLock = null;
    this.syncManager = null;

    createWriteQueue(this);
    this._bindApiMethods();
    this.initPromise = this._initialize();
  }

  _bindApiMethods() {
    this.insert = crudOps.insert.bind(this);
    this.insertMany = crudOps.insertMany.bind(this);
    this.update = crudOps.update.bind(this);
    this.remove = crudOps.remove.bind(this);
    this.removeMany = crudOps.removeMany.bind(this);
    this.clear = crudOps.clear.bind(this);
    this.getById = queryOps.getById.bind(this);
    this.getAll = queryOps.getAll.bind(this);
    this.count = queryOps.count.bind(this);
    this.find = queryOps.find.bind(this);
    this.findOne = queryOps.findOne.bind(this);
    this.updateOne = queryOps.updateOne.bind(this);
    this.updateMany = queryOps.updateMany.bind(this);
    this.findOneAndUpdate = queryOps.findOneAndUpdate.bind(this);
    this.deleteOne = queryOps.deleteOne.bind(this);
    this.deleteMany = queryOps.deleteMany.bind(this);
    this.findByIndexedValue = queryOps.findByIndexedValue.bind(this);
    this.findOneByIndexedValue = queryOps.findOneByIndexedValue.bind(this);
    this.exportJson = dataExchangeOps.exportJson.bind(this);
    this.exportCsv = dataExchangeOps.exportCsv.bind(this);
    this.importJson = dataExchangeOps.importJson.bind(this);
  }

  async _initialize() {
    await fs.mkdir(this.collectionDirPath, { recursive: true });
    await fs.mkdir(this.checkpointsDir, { recursive: true });
    
    await initializeWal(this.walPath, this.collectionDirPath, this.logger);
    const loadedCheckpoint = await loadLatestCheckpoint(this.checkpointsDir, this.name, this.logger);
    
    this.documents = loadedCheckpoint.documents;
    this._stats.lastCheckpointTimestamp = loadedCheckpoint.timestamp || null;

    for (const indexMeta of loadedCheckpoint.indexesMeta || []) {
        try {
            this._indexManager.createIndex(indexMeta.fieldName, { unique: indexMeta.type === 'unique' });
        } catch (e) { /* ignore */ }
    }
    this._indexManager.rebuildIndexesFromData(this.documents);

    const walReadOpts = { ...this.options.walReadOptions, isInitialLoad: true, logger: this.logger };
    const walEntries = await readWal(this.walPath, this._stats.lastCheckpointTimestamp, walReadOpts);

    const isInitialLoad = true;
    for (const entry of walEntries) {
      if (entry.txn === 'op' && entry._txn_applied_from_wal) {
        await this._applyTransactionWalOp(entry, isInitialLoad);
      } else if (!entry.txn) {
        this._applyWalEntryToMemory(entry, false, isInitialLoad);
      }
    }

    this._stats.walEntriesSinceCheckpoint = walEntries.length;
    this._indexManager.rebuildIndexesFromData(this.documents);

    this._startCheckpointTimer();
    this._startTtlCleanupTimer();

    this._emitter.emit('initialized');
    return true;
  }

  _applyWalEntryToMemory(entry, emitEvents = true, isInitialLoad = false) {
    switch (entry.op) {
        case 'INSERT': {
            const doc = entry.doc;
            if (!doc || !doc._id) throw new Error('Cannot apply INSERT: document or _id is missing.');
            if (!isInitialLoad && this.documents.has(doc._id)) {
                if (!entry._remote) {
                    throw new Error(`Cannot apply INSERT: document with _id ${doc._id} already exists.`);
                }
            }
            this.documents.set(doc._id, doc);
            this._indexManager.afterInsert(doc);
            if (emitEvents) this._emitter.emit('insert', doc);
            break;
        }
        case 'BATCH_INSERT': {
            const docs = Array.isArray(entry.docs) ? entry.docs : [];
            if (!isInitialLoad) {
                for (const doc of docs) {
                    if (!doc || !doc._id) throw new Error('Cannot apply BATCH_INSERT: a document or its _id is missing.');
                    if (this.documents.has(doc._id) && !entry._remote) {
                        throw new Error(`Cannot apply BATCH_INSERT: document with _id ${doc._id} already exists.`);
                    }
                }
            }
            for (const doc of docs) {
                this.documents.set(doc._id, doc);
                this._indexManager.afterInsert(doc);
                if (emitEvents) this._emitter.emit('insert', doc);
            }
            break;
        }
        case 'UPDATE': {
            const id = entry.id;
            const dataToUpdate = entry.data;
            if (!id) throw new Error('Cannot apply UPDATE: id is missing.');
            const prevDoc = this.documents.get(id);

            if (!prevDoc) {
                if (isInitialLoad && dataToUpdate) {
                    const newDoc = { _id: id, createdAt: new Date().toISOString(), ...dataToUpdate, updatedAt: dataToUpdate.updatedAt || new Date().toISOString() };
                    this.documents.set(id, newDoc);
                    this._indexManager.afterInsert(newDoc);
                    if(emitEvents) this._emitter.emit('insert', newDoc);
                    return;
                }
                if (!entry._remote) {
                    throw new Error(`Cannot apply UPDATE: document with id ${id} not found.`);
                }
                return;
            }
            
            if (!isAlive(prevDoc)) throw new Error(`Cannot apply UPDATE: document with id ${id} has expired.`);
            const updatedDoc = { ...prevDoc, ...dataToUpdate };
            this.documents.set(id, updatedDoc);
            this._indexManager.afterUpdate(prevDoc, updatedDoc);
            if (emitEvents) this._emitter.emit('update', updatedDoc, prevDoc);
            break;
        }
        case 'REMOVE': {
            const id = entry.id;
            if (!id) throw new Error('Cannot apply REMOVE: id is missing.');
            const prevDoc = this.documents.get(id);
            if (!prevDoc) return;

            this.documents.delete(id);
            this._indexManager.afterRemove(prevDoc);
            if (emitEvents) this._emitter.emit('remove', prevDoc);
            break;
        }
        case 'CLEAR': {
            const allDocs = Array.from(this.documents.values());
            this.documents.clear();
            this._indexManager.clearAllData();
            if (emitEvents) this._emitter.emit('clear', { clearedCount: allDocs.length });
            break;
        }
        default:
            throw new Error(`Unknown operation type: ${entry.op}`);
    }
  }

  async _enqueueDataModification(entry, opType, getResultFn) {
    if (this._indexManager) {
        if (opType === 'INSERT') {
            const docToInsert = entry.doc;
            if (docToInsert) {
                for (const idxMeta of this._indexManager.getIndexesMeta()) {
                    if (idxMeta.type === 'unique') {
                        const value = docToInsert[idxMeta.fieldName];
                           if (value !== undefined && value !== null && this._indexManager.findOneIdByIndex(idxMeta.fieldName, value)) {
                                throw new UniqueConstraintError(idxMeta.fieldName, value);
                        }
                    }
                }
            }
        } else if (opType === 'BATCH_INSERT') {
            const docs = entry.docs || [];
            if (docs.length > 0) {
                for (const idxMeta of this._indexManager.getIndexesMeta()) {
                    if (idxMeta.type === 'unique') {
                        const seenValues = new Set();
                        for (const doc of docs) {
                            const value = doc[idxMeta.fieldName];
                            if (value !== undefined && value !== null) {
                                if (seenValues.has(value) || this._indexManager.findOneIdByIndex(idxMeta.fieldName, value)) {
                                    throw new UniqueConstraintError(idxMeta.fieldName, value);
                                }
                                seenValues.add(value);
                            }
                        }
                    }
                }
            }
        } else if (opType === 'UPDATE') {
            const { id, data } = entry;
            const originalDoc = this.documents.get(id);
            if (originalDoc && data) {
                for (const idxMeta of this._indexManager.getIndexesMeta()) {
                    if (idxMeta.type === 'unique' && data.hasOwnProperty(idxMeta.fieldName)) {
                        const newValue = data[idxMeta.fieldName];
                        if (newValue !== undefined && newValue !== null) {
                            const existingId = this._indexManager.findOneIdByIndex(idxMeta.fieldName, newValue);
                            if (existingId && existingId !== id) {
                                throw new UniqueConstraintError(idxMeta.fieldName, newValue);
                            }
                        }
                    }
                }
            }
        }
    }

    const entryWithOpId = { ...entry, opId: uuidv4() };
    await appendWalEntry(this.walPath, entryWithOpId, this.logger);

    this._applyWalEntryToMemory(entry, true);
    this._handlePotentialCheckpointTrigger();

    let nextResult;
    if (opType === 'INSERT') nextResult = entry.doc;
    else if (opType === 'BATCH_INSERT') nextResult = entry.docs;
    else if (opType === 'UPDATE') nextResult = this.documents.get(entry.id);

    return getResultFn ? getResultFn(undefined, nextResult) : undefined;
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
                this.logger.error(`[Collection] Auto-checkpoint error for ${this.name}: ${e.message}`, e.stack);
            }
        }, this.options.checkpointIntervalMs);
        if (this._checkpointTimerId && typeof this._checkpointTimerId.unref === 'function') {
            this._checkpointTimerId.unref();
        }
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
                const removedCount = cleanupExpiredDocs(this.documents, this._indexManager);
                if (removedCount > 0) {
                    this.logger.debug(`[Collection] [TTL] Auto-cleanup removed ${removedCount} docs from ${this.name}.`);
                }
            } catch (e) {
                this.logger.error(`[Collection] [TTL] Auto-cleanup error for ${this.name}: ${e.message}`, e.stack);
            }
        }, this.options.ttlCleanupIntervalMs);
        if (this._ttlCleanupTimer && typeof this._ttlCleanupTimer.unref === 'function') {
            this._ttlCleanupTimer.unref();
        }
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
            this.logger.error(`[Collection] Auto-checkpoint (by WAL count) error for ${this.name}: ${e.message}`, e.stack);
        });
    }
  }

  async flushToDisk() {
    return this._enqueue(async () => {
        cleanupExpiredDocs(this.documents, this._indexManager);
        
        const timestamp = new Date().toISOString();
        const meta = {
            collectionName: this.name,
            timestamp,
            documentCount: this.documents.size,
            indexesMeta: this._indexManager.getIndexesMeta() || []
        };
        
        const timestampForFile = timestamp.replace(/[:.]/g, '-');
        const metaPath = path.join(this.checkpointsDir, `checkpoint_meta_${this.name}_${timestampForFile}.json`);
        
        await writeJsonFileSafe(metaPath, meta, null, this.logger);

        const aliveDocs = Array.from(this.documents.values());
        const maxSegmentSize = this.options.maxSegmentSizeBytes;
        let segmentIndex = 0;
        let currentSegment = [];
        let currentSize = 2; 

        for (const doc of aliveDocs) {
            const docStr = JSON.stringify(doc);
            const docSize = Buffer.byteLength(docStr, 'utf8') + (currentSegment.length > 0 ? 1 : 0);
            if (currentSize + docSize > maxSegmentSize && currentSegment.length > 0) {
                const dataPath = path.join(this.checkpointsDir, `checkpoint_data_${this.name}_${timestampForFile}_seg${segmentIndex++}.json`);
                await writeJsonFileSafe(dataPath, currentSegment, null, this.logger);
                currentSegment = [];
                currentSize = 2;
            }
            currentSegment.push(doc);
            currentSize += docSize;
        }

        if (currentSegment.length > 0) {
            const dataPath = path.join(this.checkpointsDir, `checkpoint_data_${this.name}_${timestampForFile}_seg${segmentIndex++}.json`);
            await writeJsonFileSafe(dataPath, currentSegment, null, this.logger);
        }
        
        this._stats.lastCheckpointTimestamp = timestamp;
        this._stats.walEntriesSinceCheckpoint = 0;

        await compactWal(this.walPath, this._stats.lastCheckpointTimestamp, this.logger);

        if (this.options.checkpointsToKeep > 0) {
            await cleanupOldCheckpoints(this.checkpointsDir, this.name, this.options.checkpointsToKeep, this.logger);
        }
        
        this._emitter.emit('checkpoint', { timestamp });
    });
  }

  async close() {
    this.disableSync();
    this.stopCheckpointTimer();
    this._stopTtlCleanupTimer();
    await this.flushToDisk();
    await this._releaseLockIfHeld();
    this._emitter.emit('closed');
  }

  stats() {
    cleanupExpiredDocs(this.documents, this._indexManager);
    return {
      ...this._stats,
      count: this.documents.size,
    };
  }
  
  async createIndex(fieldName, options = {}) {
    return this._enqueue(async () => {
        this._indexManager.createIndex(fieldName, options);
        this._indexManager.rebuildIndexesFromData(this.documents);
    });
  }

  async dropIndex(fieldName) {
    return this._enqueue(async () => {
        this._indexManager.dropIndex(fieldName);
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
  
  async compactWalAfterPush() {
    this.logger.log(`[Collection] Compacting local state for '${this.name}' after successful sync push by flushing to disk.`);
    return this.flushToDisk();
  }

  enableSync(syncOptions) {
    if (this.syncManager) {
        this.logger.warn(`[Sync] Sync for collection '${this.name}' is already enabled.`);
        return;
    }
    const { url, apiKey, ...restOptions } = syncOptions;
    if (!url || !apiKey) {
        throw new Error('Sync requires `url` and `apiKey`.');
    }
    this.syncManager = new SyncManager({ 
        collection: this, 
        logger: this.logger,
        ...syncOptions 
    });
    
    const eventsToForward = [
        'sync:start', 'sync:success', 'sync:error', 'sync:push_success',
        'sync:pull_success', 'sync:initial_start', 'sync:initial_complete',
        'sync:conflict_resolved', 'sync:quarantine', 'sync:heartbeat_success'
    ];
    eventsToForward.forEach(eventName => {
        this.syncManager.on(eventName, (...args) => this._emitter.emit(eventName, ...args));
    });

    this.syncManager.start();
  }

  disableSync() {
    if (this.syncManager) {
        this.syncManager.stop();
        this.syncManager = null;
        this.logger.log(`[Sync] Sync for collection '${this.name}' stopped.`);
    }
  }

  async triggerSync() {
    if (!this.syncManager) {
        this.logger.warn(`[Sync] Cannot trigger sync for '${this.name}', sync is not enabled.`);
        return Promise.resolve();
    }
    return this.syncManager.runSync();
  }

  getSyncStatus() {
    if (!this.syncManager) {
        return { state: 'disabled', isSyncing: false, lastKnownServerLSN: 0, initialSyncComplete: false };
    }
    return this.syncManager.getStatus();
  }

  async _internalClear() {
    return this._enqueue(async () => {
        const clearedCount = this.documents.size;
        this.documents.clear();
        this._indexManager.clearAllData();
        this._emitter.emit('clear', { clearedCount });
    });
  }

  async _internalInsertMany(docs) {
    return this._enqueue(async () => {
        for (const doc of docs) {
            if (!doc._id) doc._id = this._idGenerator();
            if (!doc.createdAt) doc.createdAt = new Date().toISOString();
            if (!doc.updatedAt) doc.updatedAt = doc.createdAt;
            this.documents.set(doc._id, doc);
        }
        this._indexManager.rebuildIndexesFromData(this.documents);
        this._emitter.emit('import', { count: docs.length });
    });
  }

  // --- ИСПРАВЛЕНИЕ НАЧИНАЕТСЯ ЗДЕСЬ ---
  async _applyRemoteOperation(remoteOp) {
    if (!remoteOp || !remoteOp.op) {
        this.logger.warn(`[Sync] Received invalid remote operation:`, remoteOp);
        return;
    }

    // Ставим всю логику применения удаленной операции в очередь,
    // чтобы избежать гонок данных при одновременных PUSH-запросах на сервере.
    return this._enqueue(async () => {
      const docId = remoteOp.id || remoteOp.doc?._id;
      const localDoc = docId ? this.documents.get(docId) : null;
  
      if (remoteOp.op === 'INSERT' && localDoc) {
        this.logger.debug(`[Sync] Ignored remote INSERT for existing document ID: ${docId}`);
        return;
      }
  
      if (remoteOp.op === 'UPDATE' && !localDoc) {
        this.logger.warn(`[Sync] Ignored remote UPDATE for non-existent document ID: ${docId}`);
        return;
      }
  
      const remoteTimestampStr = remoteOp.ts || remoteOp.doc?.updatedAt || remoteOp.data?.updatedAt;
      if (localDoc && remoteTimestampStr) {
        try {
          const remoteTimestamp = new Date(remoteTimestampStr).getTime();
          const localTimestamp = new Date(localDoc.updatedAt).getTime();
          if (localTimestamp > remoteTimestamp) {
            this._emitter.emit('sync:conflict_resolved', {
              type: 'ignored_remote', reason: 'local_is_newer', docId,
              localTimestamp: localDoc.updatedAt, remoteTimestamp: remoteTimestampStr
            });
            this.logger.log(`[Sync] Ignored remote op for doc ${docId} because local version is newer.`);
            return;
          }
        } catch (e) {
          this.logger.warn(`[Sync] Could not parse timestamp for conflict resolution. Error: ${e.message}`);
        }
      }
  
      try {
        // Теперь вызов происходит внутри очереди с захваченной блокировкой.
        this._applyWalEntryToMemory(remoteOp, true, false);
        const entry = { ...remoteOp, _remote: true };
        // Записываем в WAL, чтобы пережить перезапуск.
        await appendWalEntry(this.walPath, entry, this.logger);
      } catch (err) {
        this.logger.error(`[Sync] Failed to apply remote op. Quarantining. Op: ${JSON.stringify(remoteOp)}`, err.message);
        await this._quarantineOperation(remoteOp, err);
      }
    });
  }
  // --- ИСПРАВЛЕНИЕ ЗАКАНЧИВАЕТСЯ ЗДЕСЬ ---
  
  async _quarantineOperation(op, error) {
      const quarantineEntry = {
          quarantinedAt: new Date().toISOString(),
          operation: op,
          error: {
              message: error.message,
              stack: error.stack,
          },
      };
      try {
          await fs.appendFile(this.quarantinePath, JSON.stringify(quarantineEntry) + '\n', 'utf8');
          this._emitter.emit('sync:quarantine', quarantineEntry);
      } catch (qErr) {
          this.logger.error(`[Sync] CRITICAL: Failed to write to quarantine log file at ${this.quarantinePath}`, qErr);
      }
  }

  async _applyTransactionWalOp(entry, isInitialLoad = false) {
    const txidForLog = entry.txid || entry.id || 'unknown_txid';
    switch (entry.type) {
      case 'insert': await this._applyTransactionInsert(entry.args[0], txidForLog, isInitialLoad); break;
      case 'insertMany': await this._applyTransactionInsertMany(entry.args[0], txidForLog, isInitialLoad); break;
      case 'update': await this._applyTransactionUpdate(entry.args[0], entry.args[1], txidForLog, isInitialLoad); break;
      case 'remove': await this._applyTransactionRemove(entry.args[0], txidForLog, isInitialLoad); break;
      case 'clear': await this._applyTransactionClear(txidForLog, isInitialLoad); break;
      default: this.logger.warn(`[Collection] Unknown transactional WAL op type '${entry.type}' for ${this.name}, txid: ${txidForLog}`);
    }
  }
  async _applyTransactionInsert(docData, txid, isInitialLoad = false) {
    const _id = docData._id || this._idGenerator();
    if (!isInitialLoad && this.documents.has(_id)) {
        throw new Error(`Cannot apply transaction insert: document with _id ${_id} already exists.`);
    }
    const now = new Date().toISOString();
    const finalDoc = { ...docData, _id, createdAt: docData.createdAt || now, updatedAt: docData.updatedAt || now, _txn: txid };
    this.documents.set(_id, finalDoc);
    this._indexManager.afterInsert(finalDoc);
    this._stats.inserts++;
    this._emitter.emit('insert', finalDoc);
    return finalDoc;
  }
  async _applyTransactionInsertMany(docsData, txid, isInitialLoad = false) {
    if (!isInitialLoad) {
        for(const docData of docsData) {
            const _id = docData._id || this._idGenerator();
            if(this.documents.has(_id)) throw new Error(`Cannot apply transaction insertMany: document with _id ${_id} already exists.`);
        }
    }
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
  async _applyTransactionUpdate(id, updates, txid, isInitialLoad = false) {
    const oldDoc = this.documents.get(id);
    if (!oldDoc && !isInitialLoad) throw new Error(`Cannot apply transaction update: document with id ${id} not found.`);
    if (!oldDoc) return null;
    
    const { _id, createdAt, ...restOfUpdates } = updates;
    const now = new Date().toISOString();
    const newDoc = { ...oldDoc, ...restOfUpdates, updatedAt: updates.updatedAt || now, _txn: txid };
    this.documents.set(id, newDoc);
    this._indexManager.afterUpdate(oldDoc, newDoc);
    this._stats.updates++;
    this._emitter.emit('update', newDoc, oldDoc);
    return newDoc;
  }
  async _applyTransactionRemove(id, txid, isInitialLoad = false) {
    const doc = this.documents.get(id);
    if (!doc) return false;
    this.documents.delete(id);
    this._indexManager.afterRemove(doc);
    this._stats.removes++;
    this._emitter.emit('remove', doc);
    return true;
  }
  async _applyTransactionClear(txid, isInitialLoad = false) {
    const clearedCount = this.documents.size;
    this.documents.clear();
    this._indexManager.clearAllData();
    this._stats.clears++;
    this._stats.inserts = 0; this._stats.updates = 0; this._stats.removes = 0;
    this._stats.walEntriesSinceCheckpoint = 0;
    this._emitter.emit('clear', { clearedCount, _txn: txid });
    return true;
  }
}

module.exports = Collection;