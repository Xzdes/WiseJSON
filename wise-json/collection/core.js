// wise-json/collection/core.js

const path = require('path');
const fs = require('fs/promises');
const CollectionEventEmitter = require('./events.js');
const IndexManager = require('./indexes.js');
const createCheckpointController = require('./checkpoints.js'); // Функция-фабрика
const {
  defaultIdGenerator,
  isNonEmptyString,
  isPlainObject, // Экспортируем для использования в ops.js через this.isPlainObject
  makeAbsolutePath,
  // flattenDocToCsv здесь не нужен, он используется в data-exchange.js
} = require('./utils.js');
const {
  initializeWal,
  readWal,
  getWalPath,
  compactWal,
} = require('../wal-manager.js');
const { loadLatestCheckpoint, cleanupOldCheckpoints } = require('../checkpoint-manager.js');
const { cleanupExpiredDocs, isAlive } = require('./ttl.js'); // isAlive используется здесь и в query-ops.js
const { acquireCollectionLock, releaseCollectionLock } = require('./file-lock.js');
const { createWriteQueue } = require('./queue.js'); // Инициализирует методы очереди на экземпляре

// Импорт модулей с операциями
const crudOps = require('./ops.js');
const queryOps = require('./query-ops.js');
const dataExchangeOps = require('./data-exchange.js');

// Валидация опций коллекции
function validateCollectionOptions(opts = {}) {
    const defaults = {
        maxSegmentSizeBytes: 2 * 1024 * 1024, // 2MB
        checkpointIntervalMs: 5 * 60 * 1000,  // 5 минут
        ttlCleanupIntervalMs: 60 * 1000,      // 1 минута
        walForceSync: false, // Относится к опциям ОС при записи, не к блокирующей/неблокирующей записи JS
        idGenerator: defaultIdGenerator,
        checkpointsToKeep: 5,
        maxWalEntriesBeforeCheckpoint: 1000, // 0 или <0 для отключения триггера по кол-ву
        walReadOptions: { recover: false, strict: false } // Опции для readWal при инициализации
    };
    const options = { ...defaults, ...opts };

    // Простая валидация типов, можно расширить
    if (typeof options.maxSegmentSizeBytes !== 'number' || options.maxSegmentSizeBytes <= 0) options.maxSegmentSizeBytes = defaults.maxSegmentSizeBytes;
    if (typeof options.checkpointIntervalMs !== 'number' || options.checkpointIntervalMs < 0) options.checkpointIntervalMs = defaults.checkpointIntervalMs;
    if (typeof options.ttlCleanupIntervalMs !== 'number' || options.ttlCleanupIntervalMs <= 0) options.ttlCleanupIntervalMs = defaults.ttlCleanupIntervalMs;
    if (typeof options.walForceSync !== 'boolean') options.walForceSync = defaults.walForceSync;
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
    this.isPlainObject = isPlainObject; // Для ops.js

    this._emitter = new CollectionEventEmitter(this.name);
    this._indexManager = new IndexManager(this.name);
    
    this._checkpoint = createCheckpointController({
      collectionName: this.name,
      collectionDirPath: this.collectionDirPath, // Передаем полный путь
      documents: this.documents,
      options: this.options,
      getIndexesMeta: () => this._indexManager.getIndexesMeta(),
    });

    // Статистика
    this._stats = { 
        inserts: 0, 
        updates: 0, 
        removes: 0, 
        clears: 0, 
        walEntriesSinceCheckpoint: 0 
    };

    // Состояние
    this._lastCheckpointTimestamp = null;
    this._checkpointTimerId = null;
    this._ttlCleanupTimer = null;
    this._releaseLock = null; // Функция для освобождения блокировки файла

    // Инициализация очереди записи (добавляет методы _enqueue, _processQueue и др. в this)
    createWriteQueue(this);

    // Привязываем методы из внешних модулей к текущему экземпляру
    // CRUD операции
    this.insert = crudOps.insert.bind(this);
    this.insertMany = crudOps.insertMany.bind(this);
    this.update = crudOps.update.bind(this);
    this.updateMany = crudOps.updateMany.bind(this);
    this.remove = crudOps.remove.bind(this);
    this.removeMany = crudOps.removeMany.bind(this);
    this.clear = crudOps.clear.bind(this);

    // Операции чтения
    this.getById = queryOps.getById.bind(this);
    this.getAll = queryOps.getAll.bind(this);
    this.count = queryOps.count.bind(this);
    this.find = queryOps.find.bind(this);
    this.findOne = queryOps.findOne.bind(this);
    this.findByIndexedValue = queryOps.findByIndexedValue.bind(this);
    this.findOneByIndexedValue = queryOps.findOneByIndexedValue.bind(this);

    // Операции импорта/экспорта
    this.exportJson = dataExchangeOps.exportJson.bind(this);
    this.exportCsv = dataExchangeOps.exportCsv.bind(this);
    this.importJson = dataExchangeOps.importJson.bind(this);
    
    // Асинхронная инициализация
    this.initPromise = this._initialize();
  }

  // --- Внутренние методы для WAL и модификации данных ---
  // Ранее это было в createWalOps, теперь инкапсулировано в классе
  
  /**
   * Применяет запись из WAL к данным в памяти (this.documents и this._indexManager).
   * @private
   */
  _applyWalEntryToMemory(entry, emitEvents = true) {
    if (entry.op === 'INSERT') {
        const doc = entry.doc;
        if (doc) { // Проверка isAlive() была убрана, т.к. вставляем все, TTL сработает позже
            this.documents.set(doc._id, doc);
            this._indexManager.afterInsert(doc);
            if (emitEvents) this._emitter.emit('insert', doc);
        }
    } else if (entry.op === 'BATCH_INSERT') {
        const docs = Array.isArray(entry.docs) ? entry.docs : [];
        for (const doc of docs) {
            if (doc) { // isAlive() убрана
                this.documents.set(doc._id, doc);
                this._indexManager.afterInsert(doc);
                if (emitEvents) this._emitter.emit('insert', doc);
            }
        }
    } else if (entry.op === 'UPDATE') {
        const id = entry.id;
        const prevDoc = this.documents.get(id); 
        if (prevDoc && isAlive(prevDoc)) { // Для UPDATE проверяем, что обновляемый документ "жив"
            const updatedDoc = { ...prevDoc, ...entry.data };
            this.documents.set(id, updatedDoc);
            this._indexManager.afterUpdate(prevDoc, updatedDoc);
            if (emitEvents) this._emitter.emit('update', updatedDoc, prevDoc);
        }
    } else if (entry.op === 'REMOVE') {
        const id = entry.id;
        const prevDoc = this.documents.get(id);
        if (prevDoc) { // Удаляем независимо от isAlive, если команда пришла
            this.documents.delete(id);
            this._indexManager.afterRemove(prevDoc);
            if (emitEvents) this._emitter.emit('remove', prevDoc);
        }
    } else if (entry.op === 'CLEAR') {
        const allDocs = Array.from(this.documents.values()); // Для корректного обновления индексов
        this.documents.clear(); 
        for (const doc of allDocs) {
            this._indexManager.afterRemove(doc);
        }
        this._indexManager.clearAllData(); // Убедимся, что все данные индексов очищены
        if (emitEvents) this._emitter.emit('clear');
    }
  }

  /**
   * Основной метод для выполнения операций, модифицирующих данные.
   * Включает проверки уникальности, запись в WAL, применение в памяти и триггер чекпоинта.
   * Вызывается из методов в ops.js (insert, update и т.д.) внутри _enqueue.
   * @private
   */
  async _enqueueDataModification(entry, opType, getResultFn, extra = {}) {
    // Проверки уникальности (если применимо и есть indexManager)
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
                            if (index.data.get(valueToInsert) !== docToInsert._id) { // Дубликат
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
        } else if (opType === 'UPDATE') { // Предварительная проверка для UPDATE
            const docId = entry.id;
            const updates = entry.data;
            const originalDoc = this.documents.get(docId);
            if (originalDoc && updates) { // Убедимся, что есть что обновлять и чем
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
    
    // Запись в WAL
    const walEntryString = JSON.stringify(entry) + '\n';
    // this.walPath уже содержит полный путь
    await fs.mkdir(path.dirname(this.walPath), { recursive: true }); // Убедимся, что директория существует
    await fs.appendFile(this.walPath, walEntryString, 'utf8');

    // Применение в памяти
    this._applyWalEntryToMemory(entry, true); // true - эмитить события

    // Триггер чекпоинта по количеству записей WAL
    this._handlePotentialCheckpointTrigger(entry); 
    
    // Формирование результата
    let prevResult = undefined; // Для getResultFn, если ей нужен prev
    let nextResult = undefined;

    if (opType === 'INSERT') nextResult = entry.doc;
    else if (opType === 'BATCH_INSERT') nextResult = entry.docs;
    else if (opType === 'UPDATE') nextResult = this.documents.get(entry.id); // Обновленный документ
    // Для REMOVE/CLEAR результат обычно boolean, формируемый getResultFn

    return getResultFn ? getResultFn(prevResult, nextResult) : undefined;
  }

  // --- Инициализация и управление жизненным циклом ---
  async _initialize() {
    await fs.mkdir(this.collectionDirPath, { recursive: true });
    await fs.mkdir(this.checkpointsDir, { recursive: true }); // Убедимся, что директория чекпоинтов создана
    await initializeWal(this.walPath, this.collectionDirPath);

    const loadedCheckpoint = await loadLatestCheckpoint(this.checkpointsDir, this.name);

    for (const [id, doc] of loadedCheckpoint.documents.entries()) {
        this.documents.set(id, doc);
    }
    for (const indexMeta of loadedCheckpoint.indexesMeta || []) {
        try {
            this._indexManager.createIndex(indexMeta.fieldName, { unique: indexMeta.type === 'unique' });
        } catch (e) {
            // console.warn(`[WiseJSON] Failed to restore index '${indexMeta.fieldName}' for collection '${this.name}': ${e.message}`);
        }
    }

    const walEntries = await readWal(this.walPath, loadedCheckpoint.timestamp, this.options.walReadOptions);
    if (walEntries.length > 0) {
    //   console.log(`[WiseJSON] Applying ${walEntries.length} WAL entries for collection: ${this.name}`);
    }
    for (const entry of walEntries) {
      if (entry.txn === 'op' && entry._txn_applied) { // Транзакционные операции
        await this._applyTransactionWalOp(entry);
      } else if (!entry.txn) { // Обычные операции
        this._applyWalEntryToMemory(entry, false); // false - не эмитить события при инициализации
      }
    }

    this._stats.walEntriesSinceCheckpoint = 0; // Сбрасываем после восстановления
    this._indexManager.rebuildIndexesFromData(this.documents); // Важно перестроить индексы после всех загрузок
    
    this._startCheckpointTimer();
    this._startTtlCleanupTimer();
    this._lastCheckpointTimestamp = loadedCheckpoint.timestamp || null;
    return true; // Для разрешения initPromise
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
                // console.log(`[WiseJSON] Auto-checkpoint triggered by timer for collection: ${this.name}`);
                await this.flushToDisk();
            } catch (e) {
                console.error(`[WiseJSON] Error during auto-checkpoint for ${this.name}:`, e);
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
            // Запускаем в try/catch, чтобы ошибка в cleanup не остановила таймер
            try {
                const removed = cleanupExpiredDocs(this.documents, this._indexManager);
                if (removed > 0) {
                //   console.log(`[WiseJSON] [TTL] Auto-cleanup: removed ${removed} documents (collection: ${this.name})`);
                }
            } catch (e) {
                console.error(`[WiseJSON] [TTL] Error during auto-cleanup for ${this.name}:`, e);
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
  
  _handlePotentialCheckpointTrigger(walEntry) {
    this._stats.walEntriesSinceCheckpoint++;
    if (this.options.maxWalEntriesBeforeCheckpoint > 0 &&
        this._stats.walEntriesSinceCheckpoint >= this.options.maxWalEntriesBeforeCheckpoint) {
        // console.log(`[WiseJSON] Auto-checkpoint triggered by WAL entry count for collection: ${this.name}`);
        this.flushToDisk().catch(e => { // Запускаем асинхронно, чтобы не блокировать текущую операцию
            console.error(`[WiseJSON] Error during WAL-triggered checkpoint for ${this.name}:`, e);
        });
    }
  }

  async flushToDisk() {
    // В реальном приложении, если flushToDisk вызывается очень часто,
    // это может привести к конкуренции за блокировку.
    // Очередь _enqueue должна это обрабатывать, если flushToDisk также ставится в очередь.
    // Но flushToDisk - это скорее административная операция.
    // Для безопасности добавим блокировку прямо здесь.
    await this._acquireLock();
    try {
        cleanupExpiredDocs(this.documents, this._indexManager); // Очищаем TTL перед сохранением
        const checkpointResult = await this._checkpoint.saveCheckpoint(); // Сохраняем актуальное состояние
        
        let newTimestamp = null;
        if (checkpointResult && checkpointResult.meta && checkpointResult.meta.timestamp) {
            newTimestamp = checkpointResult.meta.timestamp;
        }
        this._lastCheckpointTimestamp = newTimestamp || new Date().toISOString();
        this._stats.walEntriesSinceCheckpoint = 0; // Сбрасываем счетчик

        await compactWal(this.walPath, this._lastCheckpointTimestamp); // Компактируем WAL
        
        if (this.options.checkpointsToKeep > 0) {
            await cleanupOldCheckpoints(this.checkpointsDir, this.name, this.options.checkpointsToKeep);
        }
        
        // console.log(`[WiseJSON] Flushed to disk for collection: ${this.name}`);
        return checkpointResult;
    } finally {
        await this._releaseLockIfHeld();
    }
  }

  async close() {
    this.stopCheckpointTimer();
    this._stopTtlCleanupTimer();
    await this.flushToDisk(); // Финальное сохранение
    // console.log(`[WiseJSON] Closed collection: ${this.name} (final flush complete)`);
  }

  stats() {
    cleanupExpiredDocs(this.documents, this._indexManager); // Актуализируем перед отдачей статистики
    return {
      inserts: this._stats.inserts,
      updates: this._stats.updates,
      removes: this._stats.removes,
      clears: this._stats.clears,
      count: Array.from(this.documents.values()).filter(doc => isAlive(doc)).length,
      walEntriesSinceCheckpoint: this._stats.walEntriesSinceCheckpoint,
    };
  }

  // --- Методы управления индексами ---
  async createIndex(fieldName, options = {}) {
    return this._enqueue(async () => { // Операции с индексами должны быть в очереди
        this._indexManager.createIndex(fieldName, options);
        this._indexManager.rebuildIndexesFromData(this.documents);
        // console.log(`[WiseJSON] Created index on field '${fieldName}' (collection: ${this.name})`);
        // Последующий flushToDisk сохранит метаданные индексов в чекпоинт
    });
  }

  async dropIndex(fieldName) {
    return this._enqueue(async () => {
        this._indexManager.dropIndex(fieldName);
        // console.log(`[WiseJSON] Dropped index on field '${fieldName}' (collection: ${this.name})`);
    });
  }

  async getIndexes() {
    return this._indexManager.getIndexesMeta(); // Чтение, не требует очереди
  }

  // --- Методы для работы с событиями ---
  on(eventName, listener) {
    this._emitter.on(eventName, listener);
  }

  off(eventName, listener) {
    this._emitter.off(eventName, listener);
  }

  // --- Внутренние методы для применения транзакционных операций ---
  // Вызываются из TransactionManager или при восстановлении WAL (_initialize)
  // Не используют _enqueue, т.к. работают в контексте уже существующей транзакции или восстановления
  async _applyTransactionWalOp(entry) {
    switch (entry.type) {
      case 'insert': await this._applyTransactionInsert(entry.args[0], entry.txid); break;
      case 'insertMany': await this._applyTransactionInsertMany(entry.args[0], entry.txid); break;
      case 'update': await this._applyTransactionUpdate(entry.args[0], entry.args[1], entry.txid); break;
      case 'remove': await this._applyTransactionRemove(entry.args[0], entry.txid); break;
      case 'clear': await this._applyTransactionClear(entry.txid); break;
      default: console.warn(`[WiseJSON] Unknown transaction WAL op type in collection ${this.name}: ${entry.type}`);
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
    // Убедимся, что не обновляем системные поля напрямую, кроме updatedAt
    const { _id, createdAt, _txn, ...restOfUpdates } = updates;
    const now = new Date().toISOString();
    const newDoc = { ...oldDoc, ...restOfUpdates, updatedAt: now, _txn: txid };
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
    this._indexManager.clearAllData(); // Убедимся, что все очищено
    this._stats.clears++;
    this._stats.inserts = 0; this._stats.updates = 0; this._stats.removes = 0;
    this._stats.walEntriesSinceCheckpoint = 0;
    this._emitter.emit('clear');
    return true;
  }
}

module.exports = Collection;