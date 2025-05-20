// wise-json/collection.js
const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const WalManager = require('./wal-manager.js');
const CheckpointManager = require('./checkpoint-manager.js');
const StorageUtils = require('./storage-utils.js');

const DEFAULT_JSON_INDENT = 2;
const DEFAULT_MAX_SEGMENT_SIZE_BYTES = 1 * 1024 * 1024;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_WAL_ENTRIES_BEFORE_CHECKPOINT = 1000;
const DEFAULT_WAL_FORCE_SYNC = false; 
const DEFAULT_CHECKPOINTS_TO_KEEP = 2;

class Collection {
    constructor(collectionName, dbDirectoryPath, options = {}) {
        this.collectionName = collectionName;
        this.dbDirectoryPath = dbDirectoryPath; 
        this.collectionDirectoryPath = path.join(dbDirectoryPath, collectionName); 
        
        this.options = {
            jsonIndent: options.jsonIndent !== undefined ? options.jsonIndent : DEFAULT_JSON_INDENT,
            idGenerator: options.idGenerator || (() => uuidv4()),
            maxSegmentSizeBytes: options.maxSegmentSizeBytes || DEFAULT_MAX_SEGMENT_SIZE_BYTES,
            checkpointIntervalMs: options.checkpointIntervalMs !== undefined ? options.checkpointIntervalMs : DEFAULT_CHECKPOINT_INTERVAL_MS,
            maxWalEntriesBeforeCheckpoint: options.maxWalEntriesBeforeCheckpoint !== undefined ? options.maxWalEntriesBeforeCheckpoint : DEFAULT_MAX_WAL_ENTRIES_BEFORE_CHECKPOINT,
            walForceSync: options.walForceSync !== undefined ? options.walForceSync : DEFAULT_WAL_FORCE_SYNC,
            checkpointsToKeep: (options.checkpointsToKeep !== undefined && Number.isInteger(options.checkpointsToKeep) && options.checkpointsToKeep >= 1) 
                                ? options.checkpointsToKeep 
                                : DEFAULT_CHECKPOINTS_TO_KEEP,
        };

        this.documents = new Map();
        this.walPath = WalManager.getWalPath(this.collectionDirectoryPath, this.collectionName);
        this.checkpointsDirPath = CheckpointManager.getCheckpointsPath(this.collectionDirectoryPath);

        this.writeQueue = Promise.resolve();
        this.isInitialized = false;
        this.initPromise = null; 

        this.walEntriesCountSinceLastCheckpoint = 0;
        this.checkpointTimerId = null;
        this.lastCheckpointTimestamp = null;
        this.isCheckpointScheduledOrRunning = false;

        this.indexes = new Map();
        this.indexedFields = new Set();

        this._listeners = {};
        
        this.initPromise = this._initializeAndRecover();
    }

    async _initializeAndRecover() {
        try {
            await StorageUtils.ensureDirectoryExists(this.collectionDirectoryPath);
            await WalManager.initializeWal(this.walPath, this.collectionDirectoryPath);

            const checkpointResult = await CheckpointManager.loadLatestCheckpoint(this.checkpointsDirPath, this.collectionName);
            this.documents = checkpointResult.documents; 
            this.lastCheckpointTimestamp = checkpointResult.timestamp; 
            const loadedIndexMetas = checkpointResult.indexesMeta || []; 

            const loadedDocsCount = this.documents.size;
            console.log(`Collection ('${this.collectionName}'): Загружен чекпоинт от ${this.lastCheckpointTimestamp || 'N/A'}. Документов из чекпоинта: ${loadedDocsCount}. Найдено определений индексов: ${loadedIndexMetas.length}`);

            const walOperations = await WalManager.readWal(this.walPath, this.lastCheckpointTimestamp);
            let appliedWalOpsCount = 0;
            for (const entry of walOperations) {
                this._applyWalEntryToMemory(entry, false); 
                appliedWalOpsCount++;
            }
            this.walEntriesCountSinceLastCheckpoint = appliedWalOpsCount; 
            console.log(`Collection ('${this.collectionName}'): Применено ${appliedWalOpsCount} операций из WAL. Всего документов в памяти: ${this.documents.size}.`);
            
            if (loadedIndexMetas.length > 0) {
                console.log(`Collection ('${this.collectionName}'): Перестроение ${loadedIndexMetas.length} индексов на основе данных из чекпоинта и WAL...`);
                for (const meta of loadedIndexMetas) {
                    try {
                        this._buildIndexInternal(meta.fieldName, { unique: meta.type === 'unique' });
                    } catch (indexError) {
                        console.error(`Collection ('${this.collectionName}'): Ошибка автоматического перестроения индекса для '${meta.fieldName}' при инициализации: ${indexError.message}`);
                    }
                }
            }

            this._setupAutomaticCheckpoints();
            
            CheckpointManager.cleanupOldCheckpoints(this.checkpointsDirPath, this.collectionName, this.options.checkpointsToKeep)
                .catch(err => console.error(`Collection ('${this.collectionName}'): Ошибка при фоновой очистке старых чекпоинтов: ${err.message}`));

            this.isInitialized = true;
            console.log(`Collection ('${this.collectionName}'): Инициализация успешно завершена.`);
        } catch (error) {
            const errorMessage = `Collection ('${this.collectionName}') CRITICAL: Ошибка инициализации: ${error.message}`;
            console.error(errorMessage, error.stack);
            this.isInitialized = false; 
            throw error; 
        }
    }

    _updateIndexesAfterInsert(newDoc) {
        if (!this.isInitialized || this.indexes.size === 0 || !newDoc) return;
        for (const fieldName of this.indexedFields) {
            const indexDef = this.indexes.get(fieldName);
            if (!indexDef) continue;
            const value = newDoc[fieldName];
            if (indexDef.type === 'unique') {
                if (value !== undefined && value !== null) {
                    if (indexDef.data.has(value) && indexDef.data.get(value) !== newDoc._id) {
                         console.error(`Collection ('${this.collectionName}') CRITICAL INDEX ERROR (Insert): Попытка добавить дублирующееся значение '${value}' в уник. индекс '${fieldName}' для ID ${newDoc._id}, но оно уже занято ID ${indexDef.data.get(value)}.`);
                    }
                    indexDef.data.set(value, newDoc._id);
                }
            } else { 
                let idSet = indexDef.data.get(value);
                if (!idSet) { idSet = new Set(); indexDef.data.set(value, idSet); }
                idSet.add(newDoc._id);
            }
        }
    }

    _updateIndexesAfterRemove(oldDoc) {
        if (!this.isInitialized || this.indexes.size === 0 || !oldDoc) return;
        for (const fieldName of this.indexedFields) {
            const indexDef = this.indexes.get(fieldName);
            if (!indexDef) continue;
            const value = oldDoc[fieldName];
            if (indexDef.type === 'unique') {
                 if (value !== undefined && value !== null) {
                    if (indexDef.data.get(value) === oldDoc._id) { 
                        indexDef.data.delete(value);
                    }
                }
            } else { 
                const idSet = indexDef.data.get(value);
                if (idSet) { idSet.delete(oldDoc._id); if (idSet.size === 0) indexDef.data.delete(value); }
            }
        }
    }

    _updateIndexesAfterUpdate(oldDoc, updatedDoc) {
        if (!this.isInitialized || this.indexes.size === 0 || !oldDoc || !updatedDoc) return;
        for (const fieldName of this.indexedFields) { 
            const indexDef = this.indexes.get(fieldName);
            if (!indexDef) continue;
            const oldValue = oldDoc[fieldName];
            const newValue = updatedDoc[fieldName];
            const valueEffectivelyChanged = (oldValue !== newValue) ||
                                 ( (oldValue === null || oldValue === undefined) && (newValue !== null && newValue !== undefined) ) ||
                                 ( (oldValue !== null && oldValue !== undefined) && (newValue === null || newValue === undefined) );
            if (valueEffectivelyChanged) {
                if (indexDef.type === 'unique') {
                    if (oldValue !== undefined && oldValue !== null) if (indexDef.data.get(oldValue) === oldDoc._id) indexDef.data.delete(oldValue);
                    if (newValue !== undefined && newValue !== null) {
                         if (indexDef.data.has(newValue) && indexDef.data.get(newValue) !== updatedDoc._id) console.error(`Collection ('${this.collectionName}') CRITICAL INDEX ERROR (Update): Попытка добавить дублирующееся значение '${newValue}' в уник. индекс '${fieldName}' для ID ${updatedDoc._id}, но оно уже занято ID ${indexDef.data.get(newValue)}.`);
                        indexDef.data.set(newValue, updatedDoc._id);
                    }
                } else { 
                    const idSetOld = indexDef.data.get(oldValue);
                    if (idSetOld) { idSetOld.delete(oldDoc._id); if (idSetOld.size === 0) indexDef.data.delete(oldValue); }
                    let idSetNew = indexDef.data.get(newValue);
                    if (!idSetNew) { idSetNew = new Set(); indexDef.data.set(newValue, idSetNew); }
                    idSetNew.add(updatedDoc._id);
                }
            }
        }
    }

    _applyWalEntryToMemory(entry, isLiveOperation = true) {
        if (!entry || typeof entry.op !== 'string') {
            console.warn(`Collection ('${this.collectionName}'): Пропущена некорректная WAL-подобная запись: ${JSON.stringify(entry)}`);
            return null;
        }
        const opTimestamp = entry.ts || (isLiveOperation ? new Date().toISOString() : null);
        let affectedDoc = null; 

        switch (entry.op) {
            case 'INSERT':
                if (entry.doc && typeof entry.doc._id === 'string') {
                    const docToStore = { ...entry.doc };
                    if (isLiveOperation) { 
                        if (!docToStore.createdAt && opTimestamp) docToStore.createdAt = opTimestamp;
                        if (!docToStore.updatedAt && opTimestamp) docToStore.updatedAt = opTimestamp;
                    } else { 
                        docToStore.createdAt = entry.doc.createdAt || opTimestamp;
                        docToStore.updatedAt = entry.doc.updatedAt || opTimestamp;
                    }
                    this.documents.set(docToStore._id, docToStore);
                    affectedDoc = docToStore;
                } else { console.warn(`Collection ('${this.collectionName}'): Пропущена INSERT запись (нет doc или _id).`); }
                break;
            case 'UPDATE':
                if (typeof entry.id === 'string' && entry.data && typeof entry.data === 'object') {
                    if (this.documents.has(entry.id)) {
                        const existingDoc = this.documents.get(entry.id);
                        const updatedDoc = { ...existingDoc, ...entry.data };
                        updatedDoc.updatedAt = entry.data.updatedAt || opTimestamp;
                        this.documents.set(entry.id, updatedDoc);
                        affectedDoc = updatedDoc;
                    }
                } else { console.warn(`Collection ('${this.collectionName}'): Пропущена UPDATE запись (нет id или data).`); }
                break;
            case 'REMOVE':
                if (typeof entry.id === 'string') {
                    affectedDoc = this.documents.get(entry.id); 
                    if (affectedDoc) this.documents.delete(entry.id);
                    else affectedDoc = null; 
                } else { console.warn(`Collection ('${this.collectionName}'): Пропущена REMOVE запись (нет id).`); }
                break;
            case 'CLEAR':
                this.documents.clear();
                affectedDoc = null; 
                break;
            default: console.warn(`Collection ('${this.collectionName}'): Неизвестная операция '${entry.op}' в WAL.`);
        }
        return affectedDoc; 
    }
    
    async _performCheckpoint() {
        if (!this.isInitialized) {
            console.warn(`Collection ('${this.collectionName}'): Попытка чекпоинта на неиниц. коллекции.`); return null;
        }
        
        const documentsSnapshot = new Map(this.documents); 
        const checkpointAttemptTs = new Date().toISOString(); 
        const walToProcessPath = await WalManager.prepareWalForCheckpoint(this.walPath, checkpointAttemptTs);
        console.log(`Collection ('${this.collectionName}'): Начало чекпоинта (ts: ${checkpointAttemptTs}). WAL для обработки: "${path.basename(walToProcessPath)}".`);
        
        try {
            const indexMetadataForCheckpoint = Array.from(this.indexes.values()).map(idxDef => ({
                fieldName: idxDef.fieldName,
                type: idxDef.type,
            }));

            const checkpointMetaResult = await CheckpointManager.performCheckpoint(
                this.checkpointsDirPath, this.collectionName, documentsSnapshot, 
                checkpointAttemptTs, this.options, indexMetadataForCheckpoint
            );

            const opsMoved = await WalManager.finalizeWalAfterCheckpoint(
                this.walPath, walToProcessPath, checkpointMetaResult.timestamp, this.options.walForceSync
            );
            
            this.lastCheckpointTimestamp = checkpointMetaResult.timestamp; 
            const remainingWalOpsAfterFinalize = await WalManager.readWal(this.walPath, this.lastCheckpointTimestamp);
            this.walEntriesCountSinceLastCheckpoint = remainingWalOpsAfterFinalize.length;

            console.log(`Collection ('${this.collectionName}'): Чекпоинт создан (meta: ${checkpointMetaResult.metaFile}, ts: ${checkpointMetaResult.timestamp}). Индексов: ${indexMetadataForCheckpoint.length}. WAL обработан, ${opsMoved} оп. перенесено. Текущих WAL: ${this.walEntriesCountSinceLastCheckpoint}.`);

             CheckpointManager.cleanupOldCheckpoints(this.checkpointsDirPath, this.collectionName, this.options.checkpointsToKeep)
                .catch(err => console.error(`Collection ('${this.collectionName}'): Ошибка фоновой очистки чекпоинтов: ${err.message}`));

            return checkpointMetaResult.timestamp;
        } catch (error) {
            const errorMessage = `Collection ('${this.collectionName}') ERROR: Ошибка чекпоинта (ts: ${checkpointAttemptTs}): ${error.message}`;
            console.error(errorMessage, error.stack);
            if (await StorageUtils.pathExists(walToProcessPath)) {
                console.warn(`Collection ('${this.collectionName}'): Чекпоинт не удался. Временный WAL "${walToProcessPath}" не обработан.`);
            }
            throw new Error(errorMessage); 
        }
    }

    _triggerCheckpointIfRequired(operationName = 'after data modification') {
        if ( this.isInitialized && !this.isCheckpointScheduledOrRunning && this.options.maxWalEntriesBeforeCheckpoint > 0 &&
            this.walEntriesCountSinceLastCheckpoint >= this.options.maxWalEntriesBeforeCheckpoint ) {
            console.log(`Collection ('${this.collectionName}'): Лимит WAL (${this.walEntriesCountSinceLastCheckpoint}/${this.options.maxWalEntriesBeforeCheckpoint}) после '${operationName}', чекпоинт в очередь.`);
            this.isCheckpointScheduledOrRunning = true;
            this._enqueueInternalOperation( async () => { try { await this._performCheckpoint(); } finally { this.isCheckpointScheduledOrRunning = false; } },
                'Automatic Checkpoint by WAL limit'
            ).catch(cpError => { this.isCheckpointScheduledOrRunning = false; });
        }
    }
    
    _setupAutomaticCheckpoints() {
        if (this.checkpointTimerId) { clearInterval(this.checkpointTimerId); this.checkpointTimerId = null; }
        const intervalMs = this.options.checkpointIntervalMs;
        if (intervalMs > 0 && intervalMs !== Infinity) {
            this.checkpointTimerId = setInterval(() => {
                if (this.isInitialized && !this.isCheckpointScheduledOrRunning && this.walEntriesCountSinceLastCheckpoint > 0) {
                     console.log(`Collection ('${this.collectionName}'): Авто-чекпоинт по интервалу (${intervalMs}ms).`);
                     this.isCheckpointScheduledOrRunning = true;
                     this._enqueueInternalOperation(async () => { try { await this._performCheckpoint(); } finally { this.isCheckpointScheduledOrRunning = false; } }, 
                        'Automatic Checkpoint by Interval').catch(err => { this.isCheckpointScheduledOrRunning = false; });
                }
            }, intervalMs);
            if (this.checkpointTimerId && typeof this.checkpointTimerId.unref === 'function') this.checkpointTimerId.unref();
        }
    }

    _enqueueInternalOperation(operationFn, operationName = 'Internal Operation') {
        const promise = this.writeQueue
            .catch(prevErrInQueue => { 
                const prevOpName = prevErrInQueue && prevErrInQueue.operationName ? prevErrInQueue.operationName : 'unknown';
                console.warn(`Collection ('${this.collectionName}') Info (для '${operationName}'): Предыдущая операция ('${prevOpName}') упала: ${prevErrInQueue ? prevErrInQueue.message : 'Error'}`);
            })
            .then(() => this._ensureInitialized()) 
            .then(async () => { 
                try { return await operationFn(); } catch (currentOperationError) {
                    if (!currentOperationError.operationName) currentOperationError.operationName = operationName;
                    console.error(`Collection ('${this.collectionName}') ERROR ('${operationName}'): ${currentOperationError.message}`, currentOperationError.stack);
                    throw currentOperationError; 
                }
            });
        this.writeQueue = promise.catch(err => {});
        return promise; 
    }
    
    _enqueueDataModification(walEntry, applyToMemoryAndReturnResultFn, eventDetails) {
        const operationTimestamp = new Date().toISOString();
        // Убеждаемся, что `ts` установлена в `walEntry` перед передачей в `WalManager.appendToWal`
        // и что она будет использоваться в `_applyWalEntryToMemory`
        const finalWalEntry = { ...walEntry, ts: operationTimestamp };
        // Если в `walEntry.doc` или `walEntry.data` были createdAt/updatedAt, они сохранятся.
        // Если нет, `_applyWalEntryToMemory` использует `finalWalEntry.ts`.

        return this._enqueueInternalOperation(async () => {
            let oldDocSnapshot = null;
            if (eventDetails && (eventDetails.type === 'UPDATE' || eventDetails.type === 'REMOVE') && typeof eventDetails.id === 'string') {
                const currentDoc = this.documents.get(eventDetails.id);
                if (currentDoc) oldDocSnapshot = { ...currentDoc };
            }

            await WalManager.appendToWal(this.walPath, finalWalEntry, this.options.walForceSync);
            this.walEntriesCountSinceLastCheckpoint++;
            
            const docAffectedInMemory = this._applyWalEntryToMemory(finalWalEntry, true); 
            const result = applyToMemoryAndReturnResultFn(oldDocSnapshot, docAffectedInMemory); 

            try {
                if (finalWalEntry.op === 'INSERT' && docAffectedInMemory) this._updateIndexesAfterInsert(docAffectedInMemory);
                else if (finalWalEntry.op === 'REMOVE' && oldDocSnapshot) this._updateIndexesAfterRemove(oldDocSnapshot);
                else if (finalWalEntry.op === 'UPDATE' && oldDocSnapshot && docAffectedInMemory) this._updateIndexesAfterUpdate(oldDocSnapshot, docAffectedInMemory);
                else if (finalWalEntry.op === 'CLEAR') this.indexes.forEach(indexDef => indexDef.data.clear());
            } catch (indexUpdateError) {
                console.error(`Collection ('${this.collectionName}') CRITICAL: Ошибка обновления индекса после ${finalWalEntry.op}: ${indexUpdateError.message}. Индексы неконсистентны!`, indexUpdateError.stack);
            }

            if (eventDetails) {
                let argsForEmit = [];
                if (eventDetails.type === 'INSERT') argsForEmit = [result]; 
                else if (eventDetails.type === 'UPDATE') argsForEmit = [result, oldDocSnapshot]; 
                else if (eventDetails.type === 'REMOVE') { if (!result) return result; argsForEmit = [eventDetails.id, oldDocSnapshot]; }
                else if (eventDetails.type === 'CLEAR') argsForEmit = []; // Для события afterClear аргументы не нужны
                 this._emit(`after${eventDetails.type.charAt(0).toUpperCase() + eventDetails.type.slice(1).toLowerCase()}`, ...argsForEmit);
            }
            this._triggerCheckpointIfRequired(`Data Modification (${finalWalEntry.op})`);
            return result;
        }, `Data Mod (${finalWalEntry.op} for ID: ${finalWalEntry.id || (finalWalEntry.doc && finalWalEntry.doc._id) || 'N/A'})`);
    }

    async _ensureInitialized() {
        if (!this.initPromise) { const msg = `Collection ('${this.collectionName}'): initPromise отсутствует.`; console.error(msg); throw new Error(msg); }
        await this.initPromise; 
        if (!this.isInitialized) { const msg = `Collection ('${this.collectionName}'): Иниц. не удалась.`; console.error(msg); throw new Error(msg); }
    }

    _emit(eventName, ...args) {
        const listeners = this._listeners[eventName];
        if (listeners && listeners.length > 0) { 
            const effectiveArgs = Array.isArray(args) ? args : []; // Гарантируем, что args - это массив
            const filteredArgs = effectiveArgs.filter(arg => arg !== undefined);
            listeners.forEach(listener => { 
                try { 
                    Promise.resolve(listener(...filteredArgs))
                        .catch(e => console.error(`Coll ('${this.collectionName}') Evt Listener Err ('${eventName}'): ${e.message}`, e.stack)); 
                } catch (e) { 
                    console.error(`Coll ('${this.collectionName}') Evt Listener Sync Err ('${eventName}'): ${e.message}`, e.stack); 
                } 
            }); 
        }
    }
        
    on(eventName, listener) {
        if (typeof listener !== 'function') throw new Error(`Coll ('${this.collectionName}'): Слушатель '${eventName}' не функция.`);
        if (!this._listeners[eventName]) this._listeners[eventName] = [];
        this._listeners[eventName].push(listener);
    }

    off(eventName, listener) {
        if (!this._listeners[eventName]) return;
        if (!listener) delete this._listeners[eventName];
        else { this._listeners[eventName] = this._listeners[eventName].filter(l => l !== listener); if (this._listeners[eventName].length === 0) delete this._listeners[eventName]; }
    }
    
    async insert(dataObject) {
        await this._ensureInitialized();
        if (!dataObject || typeof dataObject !== 'object' || Array.isArray(dataObject)) throw new Error(`Coll ('${this.collectionName}'): dataObject для insert - объект.`);
        
        const docId = (typeof dataObject._id === 'string' && dataObject._id.length > 0) ? dataObject._id : this.options.idGenerator();
        const ts = new Date().toISOString();
        // Убедимся, что createdAt и updatedAt установлены здесь, чтобы они попали в WAL через newDoc
        const newDoc = { 
            ...dataObject, 
            _id: docId,    
            createdAt: typeof dataObject.createdAt === 'string' ? dataObject.createdAt : ts,
            updatedAt: typeof dataObject.updatedAt === 'string' ? dataObject.updatedAt : ts,
        };

        for (const [fieldName, indexDef] of this.indexes.entries()) {
            if (indexDef.type === 'unique') {
                const value = newDoc[fieldName];
                if (value !== undefined && value !== null) {
                    if (indexDef.data.has(value) && indexDef.data.get(value) !== newDoc._id) {
                         throw new Error(`Collection ('${this.collectionName}'): Нарушение уникального индекса по полю '${fieldName}' для значения '${value}'.`);
                    }
                }
            }
        }
        const walEntry = { op: 'INSERT', doc: { ...newDoc } }; // ts будет добавлен в _enqueueDataModification
        return this._enqueueDataModification(walEntry, 
            (oldSnap, affectedDoc) => ({ ...affectedDoc }), 
            { type: 'INSERT' } 
        );
    }

    async getById(id) { await this._ensureInitialized(); if (typeof id !== 'string' || id.length === 0) return null; const doc = this.documents.get(id); return doc ? { ...doc } : null; }
    async getAll() { await this._ensureInitialized(); return Array.from(this.documents.values()).map(doc => ({ ...doc })); }

    async find(queryFunction) {
        await this._ensureInitialized();
        if (typeof queryFunction !== 'function') throw new Error(`Coll ('${this.collectionName}'): queryFunction - функция.`);
        const results = [];
        for (const doc of this.documents.values()) if (queryFunction(doc)) results.push({ ...doc });
        return results;
    }
    
    async findOne(queryFunction) {
        await this._ensureInitialized();
         if (typeof queryFunction !== 'function') throw new Error(`Coll ('${this.collectionName}'): queryFunction - функция.`);
        for (const doc of this.documents.values()) if (queryFunction(doc)) return { ...doc };
        return null;
    }

    async update(id, updates) {
        await this._ensureInitialized();
        if (typeof id !== 'string' || id.length === 0) throw new Error(`Coll ('${this.collectionName}'): ID для update - строка.`);
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error(`Coll ('${this.collectionName}'): updates - объект.`);

        const currentDoc = this.documents.get(id);
        if (!currentDoc) return null; 

        const cleanUpdates = { ...updates }; 
        delete cleanUpdates._id; delete cleanUpdates.createdAt;
        const updateTimestamp = new Date().toISOString();
        cleanUpdates.updatedAt = updateTimestamp; // Важно для WAL и _applyWalEntryToMemory

        const potentialUpdatedDoc = { ...currentDoc, ...cleanUpdates };
        for (const [fieldName, indexDef] of this.indexes.entries()) {
            if (indexDef.type === 'unique') {
                if (Object.prototype.hasOwnProperty.call(cleanUpdates, fieldName)) {
                    const oldValue = currentDoc[fieldName];
                    const newValue = potentialUpdatedDoc[fieldName];
                    if (newValue !== undefined && newValue !== null && newValue !== oldValue) { 
                        if (indexDef.data.has(newValue) && indexDef.data.get(newValue) !== id) {
                            throw new Error(`Coll ('${this.collectionName}'): Нарушение уник. индекса '${fieldName}' ID '${id}' на '${newValue}'.`);
                        }
                    }
                }
            }
        }
        
        const walEntry = { op: 'UPDATE', id, data: cleanUpdates }; // ts будет добавлен в _enqueueDataModification
        return this._enqueueDataModification(walEntry, 
            (oldSnap, affectedDoc) => affectedDoc ? { ...affectedDoc } : null, 
            { type: 'UPDATE', id });
    }

    async remove(id) {
        await this._ensureInitialized();
        if (typeof id !== 'string' || id.length === 0) throw new Error(`Coll ('${this.collectionName}'): ID для remove - строка.`);
        
        const currentDoc = this.documents.get(id); 
        if (!currentDoc) return false;

        const walEntry = { op: 'REMOVE', id };
        return this._enqueueDataModification(walEntry, (oldSnapshot) => !!oldSnapshot, { type: 'REMOVE', id });
    }

    async count(queryFunction) {
        await this._ensureInitialized();
        if (queryFunction === undefined) return this.documents.size;
        if (typeof queryFunction !== 'function') throw new Error(`Coll ('${this.collectionName}'): queryFunction - функция.`);
        let count = 0;
        for (const doc of this.documents.values()) if (queryFunction(doc)) count++;
        return count;
    }
    
    async upsert(query, dataToUpsert, upsertOptions = {}) {
        await this._ensureInitialized();
        if (!query || (typeof query !== 'object' && typeof query !== 'function')) throw new Error(`Coll ('${this.collectionName}'): query - объект/функция.`);
        if (!dataToUpsert || typeof dataToUpsert !== 'object' || Array.isArray(dataToUpsert)) throw new Error(`Coll ('${this.collectionName}'): dataToUpsert - объект.`);

        return this._enqueueInternalOperation(async () => {
            const queryFn = typeof query === 'function' ? query : (doc => Object.keys(query).every(key => doc[key] === query[key]));
            let existingDocumentEntry = null; 
            for (const entry of this.documents.entries()) if (queryFn(entry[1])) { existingDocumentEntry = entry; break; }

            const ts = new Date().toISOString(); 
            let operationResult, finalWalEntry, eventDetails, oldDocSnapshotForEvent = null;
            let finalDocForUserAndIndex; 

            if (existingDocumentEntry) { 
                const existingId = existingDocumentEntry[0];
                const existingDoc = existingDocumentEntry[1];
                oldDocSnapshotForEvent = { ...existingDoc };

                const updatesToApply = { ...dataToUpsert }; 
                delete updatesToApply._id; delete updatesToApply.createdAt;
                updatesToApply.updatedAt = ts; // ЯВНО устанавливаем updatedAt для объекта изменений

                const potentialUpdatedDoc = { ...existingDoc, ...updatesToApply };
                for (const [fName, idxDef] of this.indexes.entries()) {
                    if (idxDef.type === 'unique') {
                        if (Object.prototype.hasOwnProperty.call(updatesToApply, fName) ) {
                            const oldValueInDoc = existingDoc[fName];
                            const newValueInDoc = potentialUpdatedDoc[fName];
                            if (newValueInDoc !== undefined && newValueInDoc !== null && newValueInDoc !== oldValueInDoc) {
                                if (idxDef.data.has(newValueInDoc) && idxDef.data.get(newValueInDoc) !== existingId) {
                                    throw new Error(`Collection ('${this.collectionName}'): Upsert (update path) нарушает уникальный индекс по полю '${fName}' для значения '${newValueInDoc}'.`);
                                }
                            }
                        }
                    }
                }
                
                finalWalEntry = { op: 'UPDATE', id: existingId, data: { ...updatesToApply }, ts }; 
                
                await WalManager.appendToWal(this.walPath, finalWalEntry, this.options.walForceSync);
                this.walEntriesCountSinceLastCheckpoint++;
                
                this._applyWalEntryToMemory(finalWalEntry, true); 
                finalDocForUserAndIndex = this.documents.get(existingId);
                this._updateIndexesAfterUpdate(oldDocSnapshotForEvent, finalDocForUserAndIndex);
                
                operationResult = { document: { ...finalDocForUserAndIndex }, operation: 'updated' };
                eventDetails = { type: 'UPDATE', doc: { ...finalDocForUserAndIndex } };
            } else { 
                let docToInsert = {};
                if (typeof query === 'object' && query !== null && !Array.isArray(query)) docToInsert = { ...query };
                docToInsert = { ...docToInsert, ...dataToUpsert };
                if (upsertOptions && upsertOptions.setOnInsert && typeof upsertOptions.setOnInsert === 'object') docToInsert = { ...docToInsert, ...upsertOptions.setOnInsert };
                docToInsert._id = (typeof docToInsert._id === 'string' && docToInsert._id.length > 0) ? docToInsert._id : this.options.idGenerator();
                docToInsert.createdAt = docToInsert.createdAt || ts; 
                docToInsert.updatedAt = ts; // ЯВНО устанавливаем

                for (const [fName, idxDef] of this.indexes.entries()) {
                    if (idxDef.type === 'unique') {
                        const value = docToInsert[fName];
                        if (value !== undefined && value !== null) {
                            if (idxDef.data.has(value) && (idxDef.data.get(value) !== docToInsert._id) ) { 
                                throw new Error(`Collection ('${this.collectionName}'): Upsert (insert path) нарушает уникальный индекс по полю '${fName}' для значения '${value}'.`);
                            }
                        }
                    }
                }
                
                finalWalEntry = { op: 'INSERT', doc: { ...docToInsert }, ts }; 
                
                await WalManager.appendToWal(this.walPath, finalWalEntry, this.options.walForceSync);
                this.walEntriesCountSinceLastCheckpoint++;
                
                this._applyWalEntryToMemory(finalWalEntry, true);
                finalDocForUserAndIndex = this.documents.get(docToInsert._id);
                this._updateIndexesAfterInsert(finalDocForUserAndIndex);
                
                operationResult = { document: { ...finalDocForUserAndIndex }, operation: 'inserted' };
                eventDetails = { type: 'INSERT', doc: { ...finalDocForUserAndIndex } };
            }
            
            if (eventDetails.type === 'INSERT' && eventDetails.doc) this._emit('afterInsert', eventDetails.doc);
            else if (eventDetails.type === 'UPDATE' && eventDetails.doc) this._emit('afterUpdate', eventDetails.doc, oldDocSnapshotForEvent);
            
            this._triggerCheckpointIfRequired('Upsert Operation');
            return operationResult;
        }, 'Upsert Operation');
    }

    async clear() {
        await this._ensureInitialized();
        const walEntry = { op: 'CLEAR' }; // ts будет добавлен в _enqueueDataModification
        return this._enqueueDataModification(walEntry, () => {}, { type: 'CLEAR' });
    }
    
    async getCollectionStats() {
        await this._ensureInitialized();
        let walSizeBytes = 0; let walExists = false;
        try { if (await StorageUtils.pathExists(this.walPath)) { walExists = true; const stats = await fs.stat(this.walPath); walSizeBytes = stats.size; }
        } catch (e) {}
        const indexInfo = Array.from(this.indexes.values()).map(idx => ({ fieldName: idx.fieldName, type: idx.type, entries: idx.data.size }));
        return {
            collectionName: this.collectionName, documentCount: this.documents.size, isInitialized: this.isInitialized,
            walPath: this.walPath, walExists, walSizeBytes, walEntriesSinceLastCheckpoint: this.walEntriesCountSinceLastCheckpoint,
            checkpointsPath: this.checkpointsDirPath, lastCheckpointTimestamp: this.lastCheckpointTimestamp,
            indexes: indexInfo, options: { ...this.options } 
        };
    }

    async save() { 
        await this._ensureInitialized();
        return this._enqueueInternalOperation(async () => {
            if (this.isCheckpointScheduledOrRunning) {
                console.log(`Collection ('${this.collectionName}'): Ручной save(), но чекпоинт уже выполняется/запланирован.`);
                return this.lastCheckpointTimestamp; 
            }
            if (this.walEntriesCountSinceLastCheckpoint > 0 || !this.lastCheckpointTimestamp || (this.documents.size > 0 && !this.lastCheckpointTimestamp) ) {
                this.isCheckpointScheduledOrRunning = true;
                try { return await this._performCheckpoint(); } finally { this.isCheckpointScheduledOrRunning = false; }
            } else {
                console.log(`Collection ('${this.collectionName}'): Ручной save(), нет WAL записей для чекпоинта.`);
                return this.lastCheckpointTimestamp; 
            }
        }, 'Manual Save (Checkpoint)');
    }

    async close() { 
        console.log(`Collection ('${this.collectionName}'): Попытка закрытия... Ожидание очереди операций.`);
        const finalOperationPromise = this._enqueueInternalOperation(async () => {
            console.log(`Collection ('${this.collectionName}'): Очередь операций достигла операции закрытия.`);
            if (this.checkpointTimerId) { clearInterval(this.checkpointTimerId); this.checkpointTimerId = null; console.log(`Collection ('${this.collectionName}'): Таймер авто-чекпоинтов остановлен.`); }
            let closedGracefully = false;
            if (this.isInitialized) { 
                const hasPendingWal = this.walEntriesCountSinceLastCheckpoint > 0;
                let walFileExistsAndNotEmpty = false; // Переопределяем здесь, чтобы использовать в условии
                if (await StorageUtils.pathExists(this.walPath)) { try { walFileExistsAndNotEmpty = (await fs.stat(this.walPath)).size > 0; } catch(e) {/*ignore*/} }
                const noCheckpointsYetAndHasData = !this.lastCheckpointTimestamp && (this.documents.size > 0 || walFileExistsAndNotEmpty );
                
                if (hasPendingWal || noCheckpointsYetAndHasData) {
                    if (!this.isCheckpointScheduledOrRunning) {
                        this.isCheckpointScheduledOrRunning = true;
                        try { console.log(`Collection ('${this.collectionName}'): Финальный чекпоинт при закрытии.`); await this._performCheckpoint(); closedGracefully = true; 
                        } catch (err) { console.error(`Collection ('${this.collectionName}'): Ошибка финального чекпоинта: ${err.message}`);
                        } finally { this.isCheckpointScheduledOrRunning = false; }
                    } else { console.warn(`Collection ('${this.collectionName}'): Финальный чекпоинт пропущен, другой уже выполняется.`); }
                } else { console.log(`Collection ('${this.collectionName}'): Финальный чекпоинт не требуется.`); closedGracefully = true; }
            } else { console.log(`Collection ('${this.collectionName}'): Коллекция не инициализирована, чекпоинт пропущен.`); closedGracefully = true;  }
            this.isInitialized = false; this.documents.clear(); this.indexes.clear(); this.indexedFields.clear();
            const closedError = new Error(`Collection ('${this.collectionName}') is closed.`);
            this.initPromise = Promise.reject(closedError); this.initPromise.catch(()=>{}); 
            console.log(`Collection ('${this.collectionName}'): ${closedGracefully ? 'Успешно' : 'Принудительно'} закрыта.`);
        }, 'Close Collection');
        try { await finalOperationPromise; } catch(err) {
            console.error(`Collection ('${this.collectionName}'): Ошибка закрытия: ${err.message}`);
            this.isInitialized = false; this.documents.clear(); this.indexes.clear(); this.indexedFields.clear();
            if (this.checkpointTimerId) clearInterval(this.checkpointTimerId);
            const finalError = err.operationName === 'Close Collection' ? err : new Error(`Collection ('${this.collectionName}') failed to close: ${err.message}`);
            this.initPromise = Promise.reject(finalError); this.initPromise.catch(()=>{}); 
            throw finalError; 
        }
    }

    _buildIndexInternal(fieldName, options = {}) {
        const isUnique = !!options.unique;
        console.log(`Collection ('${this.collectionName}'): Внутреннее построение ${isUnique ? 'уникального' : 'простого'} индекса для '${fieldName}'...`);
        const newIndexData = new Map();
        const tempValueSetForUniqueness = isUnique ? new Set() : null;
        for (const [docId, doc] of this.documents.entries()) {
            const value = doc[fieldName]; 
            if (isUnique) {
                if (value !== undefined && value !== null) { 
                    if (tempValueSetForUniqueness.has(value)) {
                        console.error(`Collection ('${this.collectionName}'): Нарушение уникальности при перестроении индекса '${fieldName}'. Значение: '${value}'. Док ID: ${docId} не добавлен.`);
                        continue; 
                    }
                    tempValueSetForUniqueness.add(value);
                    newIndexData.set(value, docId); 
                }
            } else { 
                let idSet = newIndexData.get(value);
                if (!idSet) { idSet = new Set(); newIndexData.set(value, idSet); }
                idSet.add(docId);
            }
        }
        this.indexes.set(fieldName, { type: isUnique ? 'unique' : 'simple', fieldName: fieldName, data: newIndexData });
        this.indexedFields.add(fieldName); // Добавляем в сет индексированных полей
        console.log(`Collection ('${this.collectionName}'): Индекс для '${fieldName}' перестроен. Записей: ${newIndexData.size}.`);
    }

    async createIndex(fieldName, options = {}) {
        await this._ensureInitialized();
        if (typeof fieldName !== 'string' || fieldName.trim() === '') throw new Error(`Coll ('${this.collectionName}'): Имя поля для индекса - непустая строка.`);
        const isUnique = !!options.unique;

        if (isUnique) {
            const tempValueSet = new Set();
            for (const doc of this.documents.values()) {
                const value = doc[fieldName];
                if (value !== undefined && value !== null) {
                    if (tempValueSet.has(value)) throw new Error(`Coll ('${this.collectionName}'): Не создать уник. индекс '${fieldName}', данные содержат дубль: '${value}'.`);
                    tempValueSet.add(value);
                }
            }
        }
        return this._enqueueInternalOperation(async () => {
            if (this.indexes.has(fieldName)) console.log(`Coll ('${this.collectionName}'): Индекс '${fieldName}' уже есть, будет перестроен.`);
            this._buildIndexInternal(fieldName, { unique: isUnique });
            
            if (!this.isCheckpointScheduledOrRunning) { 
                this.isCheckpointScheduledOrRunning = true;
                return this._performCheckpoint().finally(() => {
                    this.isCheckpointScheduledOrRunning = false;
                });
            } else {
                 console.log(`Coll ('${this.collectionName}'): Чекпоинт для сохранения индекса '${fieldName}' отложен, т.к. другой чекпоинт активен.`);
                 return this.lastCheckpointTimestamp; 
            }
        }, `CreateIndex-${fieldName}`);
    }

    async dropIndex(fieldName) {
        await this._ensureInitialized();
        if (typeof fieldName !== 'string' || fieldName.trim() === '') throw new Error(`Coll ('${this.collectionName}'): Имя поля для удаления индекса - строка.`);
        return this._enqueueInternalOperation(async () => { 
            if (this.indexes.has(fieldName)) {
                this.indexes.delete(fieldName); this.indexedFields.delete(fieldName);
                console.log(`Coll ('${this.collectionName}'): Индекс '${fieldName}' удален.`);
                if (!this.isCheckpointScheduledOrRunning) {
                    this.isCheckpointScheduledOrRunning = true;
                    await this._performCheckpoint().finally(() => { 
                        this.isCheckpointScheduledOrRunning = false;
                    });
                } else {
                    console.log(`Coll ('${this.collectionName}'): Чекпоинт для сохранения удаления индекса '${fieldName}' отложен.`);
                }
                return true;
            }
            console.log(`Coll ('${this.collectionName}'): Индекс '${fieldName}' не найден.`);
            return false;
        }, `DropIndex-${fieldName}`);
    }

    async getIndexes() {
        await this._ensureInitialized();
        return Array.from(this.indexes.values()).map(idxDef => ({ fieldName: idxDef.fieldName, type: idxDef.type, entries: idxDef.data.size }));
    }

    async findOneByIndexedValue(fieldName, value) {
        await this._ensureInitialized();
        if (!this.indexes.has(fieldName)) { console.warn(`Coll ('${this.collectionName}'): findOneByIndexedValue: нет индекса '${fieldName}'.`); return null; }
        const indexDef = this.indexes.get(fieldName); const indexData = indexDef.data; 
        if (indexDef.type === 'unique') { const docId = indexData.get(value); if (docId) { const doc = this.documents.get(docId); return doc ? { ...doc } : null; } return null;
        } else if (indexDef.type === 'simple') { const idSet = indexData.get(value); if (idSet && idSet.size > 0) { const firstId = idSet.values().next().value; const doc = this.documents.get(firstId); return doc ? { ...doc } : null; } return null; }
        return null; 
    }

    async findByIndexedValue(fieldName, value) {
        await this._ensureInitialized();
        if (!this.indexes.has(fieldName)) { console.warn(`Coll ('${this.collectionName}'): findByIndexedValue: нет индекса '${fieldName}'.`); return []; }
        const indexDef = this.indexes.get(fieldName); const indexData = indexDef.data; const results = [];
        if (indexDef.type === 'unique') { const docId = indexData.get(value); if (docId) { const doc = this.documents.get(docId); if (doc) results.push({ ...doc }); }
        } else if (indexDef.type === 'simple') { const idSet = indexData.get(value); if (idSet) { for (const docId of idSet) { const doc = this.documents.get(docId); if (doc) results.push({ ...doc }); } } }
        return results;
    }
}

module.exports = Collection;