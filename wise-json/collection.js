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

            const loadedDocsCount = this.documents.size;
            console.log(`Collection ('${this.collectionName}'): Загружен чекпоинт от ${this.lastCheckpointTimestamp || 'N/A'}. Документов из чекпоинта: ${loadedDocsCount}.`);

            const walOperations = await WalManager.readWal(this.walPath, this.lastCheckpointTimestamp);
            let appliedWalOpsCount = 0;
            for (const entry of walOperations) {
                this._applyWalEntryToMemory(entry, false); 
                appliedWalOpsCount++;
            }
            this.walEntriesCountSinceLastCheckpoint = appliedWalOpsCount; 

            console.log(`Collection ('${this.collectionName}'): Применено ${appliedWalOpsCount} операций из WAL. Всего документов в памяти: ${this.documents.size}.`);

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

    _applyWalEntryToMemory(entry, isLiveOperation = true) {
        if (!entry || typeof entry.op !== 'string') {
            console.warn(`Collection ('${this.collectionName}'): Пропущена некорректная WAL-подобная запись (отсутствует 'op'): ${JSON.stringify(entry)}`);
            return;
        }
        
        const opTimestamp = entry.ts || (isLiveOperation ? new Date().toISOString() : null);
        if (!opTimestamp && isLiveOperation) {
             console.warn(`Collection ('${this.collectionName}'): Для живой операции (${entry.op}) отсутствует временная метка, используется текущее время.`);
        }

        switch (entry.op) {
            case 'INSERT':
                if (entry.doc && typeof entry.doc._id === 'string') {
                    const docToStore = { ...entry.doc };
                    if (isLiveOperation) { 
                        if (!docToStore.createdAt && opTimestamp) docToStore.createdAt = opTimestamp;
                        if (!docToStore.updatedAt && opTimestamp) docToStore.updatedAt = opTimestamp;
                    } else { 
                        if (!docToStore.createdAt) docToStore.createdAt = entry.doc.createdAt || opTimestamp;
                        if (!docToStore.updatedAt) docToStore.updatedAt = entry.doc.updatedAt || opTimestamp;
                    }
                    this.documents.set(docToStore._id, docToStore);
                } else {
                     console.warn(`Collection ('${this.collectionName}'): Пропущена INSERT запись из-за отсутствия 'doc' или 'doc._id': ${JSON.stringify(entry)}`);
                }
                break;
            case 'UPDATE':
                if (typeof entry.id === 'string' && this.documents.has(entry.id) && entry.data && typeof entry.data === 'object') {
                    const existingDoc = this.documents.get(entry.id);
                    const updatedDoc = { ...existingDoc, ...entry.data };
                    
                    if (entry.data.updatedAt) { // Если в данных операции есть updatedAt, он приоритетнее
                        updatedDoc.updatedAt = entry.data.updatedAt;
                    } else if (opTimestamp) { // Иначе используем общий timestamp операции
                        updatedDoc.updatedAt = opTimestamp;
                    }
                    this.documents.set(entry.id, updatedDoc);
                } else {
                    if (typeof entry.id === 'string' && !this.documents.has(entry.id)) {
                        // console.log(`Collection ('${this.collectionName}'): Документ с ID '${entry.id}' не найден в памяти для операции UPDATE.`);
                    } else {
                        console.warn(`Collection ('${this.collectionName}'): Пропущена UPDATE запись для ID '${entry.id}' (некорректные данные или ID): ${JSON.stringify(entry)}`);
                    }
                }
                break;
            case 'REMOVE':
                if (typeof entry.id === 'string') {
                    this.documents.delete(entry.id);
                } else {
                     console.warn(`Collection ('${this.collectionName}'): Пропущена REMOVE запись из-за отсутствия или некорректного ID: ${JSON.stringify(entry)}`);
                }
                break;
            case 'CLEAR':
                this.documents.clear();
                break;
            default:
                console.warn(`Collection ('${this.collectionName}'): Обнаружена неизвестная операция '${entry.op}' при применении к памяти.`);
        }
    }
    
    async _performCheckpoint() {
        if (!this.isInitialized) {
            const msg = `Collection ('${this.collectionName}'): Попытка выполнить чекпоинт на неинициализированной коллекции.`;
            console.warn(msg); 
            return null;
        }
        
        const documentsSnapshot = new Map(this.documents); 
        const checkpointAttemptTs = new Date().toISOString(); 
        const walCountAtCheckpointStart = this.walEntriesCountSinceLastCheckpoint;

        console.log(`Collection ('${this.collectionName}'): Начало выполнения чекпоинта (попытка ts: ${checkpointAttemptTs}). Записей WAL с последнего чекпоинта: ${walCountAtCheckpointStart}.`);
        
        try {
            const checkpointMeta = await CheckpointManager.performCheckpoint(
                this.checkpointsDirPath,
                this.collectionName,
                documentsSnapshot, 
                checkpointAttemptTs, 
                this.options
            );

            await WalManager.processWalAfterCheckpoint(this.walPath, checkpointAttemptTs);
            
            this.walEntriesCountSinceLastCheckpoint = Math.max(0, this.walEntriesCountSinceLastCheckpoint - walCountAtCheckpointStart);
            this.lastCheckpointTimestamp = checkpointMeta.timestamp; 

            console.log(`Collection ('${this.collectionName}'): Чекпоинт успешно создан и WAL обработан (ts: ${checkpointMeta.timestamp}). Оставшиеся WAL записи для след. чекпоинта: ${this.walEntriesCountSinceLastCheckpoint}`);

             CheckpointManager.cleanupOldCheckpoints(this.checkpointsDirPath, this.collectionName, this.options.checkpointsToKeep)
                .catch(err => console.error(`Collection ('${this.collectionName}'): Ошибка при фоновой очистке старых чекпоинтов после успешного чекпоинта: ${err.message}`));

            return checkpointMeta.timestamp;
        } catch (error) {
            const errorMessage = `Collection ('${this.collectionName}') ERROR: Критическая ошибка во время выполнения чекпоинта (попытка ts: ${checkpointAttemptTs}): ${error.message}`;
            console.error(errorMessage, error.stack);
            throw new Error(errorMessage); 
        }
    }

    _triggerCheckpointIfRequired(operationName = 'after data modification') {
        if (
            this.isInitialized &&
            !this.isCheckpointScheduledOrRunning && 
            this.options.maxWalEntriesBeforeCheckpoint > 0 &&
            this.walEntriesCountSinceLastCheckpoint >= this.options.maxWalEntriesBeforeCheckpoint
        ) {
            console.log(`Collection ('${this.collectionName}'): Достигнут лимит WAL (${this.walEntriesCountSinceLastCheckpoint}/${this.options.maxWalEntriesBeforeCheckpoint}) после '${operationName}', ставим чекпоинт в очередь.`);
            
            this.isCheckpointScheduledOrRunning = true;

            this._enqueueInternalOperation(
                async () => { 
                    try {
                        await this._performCheckpoint();
                    } finally {
                        this.isCheckpointScheduledOrRunning = false; 
                    }
                },
                'Automatic Checkpoint by WAL limit'
            ).catch(cpError => { 
                this.isCheckpointScheduledOrRunning = false; 
            });
        }
    }
    
    _setupAutomaticCheckpoints() {
        if (this.checkpointTimerId) {
            clearInterval(this.checkpointTimerId);
            this.checkpointTimerId = null;
        }
        const intervalMs = this.options.checkpointIntervalMs;
        if (intervalMs > 0 && intervalMs !== Infinity) {
            this.checkpointTimerId = setInterval(() => {
                if (this.isInitialized && !this.isCheckpointScheduledOrRunning && this.walEntriesCountSinceLastCheckpoint > 0) {
                     console.log(`Collection ('${this.collectionName}'): Автоматический чекпоинт по интервалу (${intervalMs}ms).`);
                     this.isCheckpointScheduledOrRunning = true;

                     this._enqueueInternalOperation(async () => {
                        try {
                            await this._performCheckpoint();
                        } finally {
                            this.isCheckpointScheduledOrRunning = false;
                        }
                     }, 'Automatic Checkpoint by Interval').catch(err => {
                        this.isCheckpointScheduledOrRunning = false; 
                     });
                }
            }, intervalMs);
            if (this.checkpointTimerId && typeof this.checkpointTimerId.unref === 'function') {
                this.checkpointTimerId.unref(); // Не мешаем процессу завершиться
            }
        }
    }

    _enqueueInternalOperation(operationFn, operationName = 'Internal Operation') {
        const promise = this.writeQueue
            .catch(prevErrInQueue => { 
                const prevOpName = prevErrInQueue && prevErrInQueue.operationName ? prevErrInQueue.operationName : 'unknown';
                console.warn(`Collection ('${this.collectionName}') Info (для '${operationName}'): Предыдущая операция в очереди ('${prevOpName}') завершилась ошибкой: ${prevErrInQueue ? prevErrInQueue.message : 'Unknown error'}`);
            })
            .then(() => this._ensureInitialized()) 
            .then(async () => { 
                try {
                    return await operationFn();
                } catch (currentOperationError) {
                    if (!currentOperationError.operationName) { 
                        currentOperationError.operationName = operationName;
                    }
                    console.error(`Collection ('${this.collectionName}') ERROR во время выполнения операции '${operationName}': ${currentOperationError.message}`, currentOperationError.stack);
                    throw currentOperationError; 
                }
            });
            
        this.writeQueue = promise.catch(err => { /* Подавляем UnhandledPromiseRejectionWarning для this.writeQueue */ });
        return promise; 
    }
    
    _enqueueDataModification(walEntry, applyToMemoryAndReturnResultFn, eventDetails) {
        const operationTimestamp = new Date().toISOString();
        const finalWalEntry = { ts: operationTimestamp, ...walEntry };

        return this._enqueueInternalOperation(async () => {
            let oldDocSnapshot = null;
            if (eventDetails && (eventDetails.type === 'UPDATE' || eventDetails.type === 'REMOVE') && typeof eventDetails.id === 'string') {
                const currentDoc = this.documents.get(eventDetails.id);
                if (currentDoc) oldDocSnapshot = { ...currentDoc };
            }

            await WalManager.appendToWal(this.walPath, finalWalEntry, this.options.walForceSync);
            this.walEntriesCountSinceLastCheckpoint++;
            
            this._applyWalEntryToMemory(finalWalEntry, true); 
            
            const result = applyToMemoryAndReturnResultFn(oldDocSnapshot); 

            if (eventDetails) {
                let eventArg1 = result, eventArg2; 
                if (eventDetails.type === 'INSERT') {
                    eventArg1 = result; 
                } else if (eventDetails.type === 'UPDATE') {
                    eventArg1 = result; 
                    eventArg2 = oldDocSnapshot; 
                } else if (eventDetails.type === 'REMOVE') {
                    eventArg1 = eventDetails.id;
                    eventArg2 = oldDocSnapshot; 
                    if (!result) return result; 
                } else if (eventDetails.type === 'CLEAR') {
                    // No specific args for clear beyond event name
                }
                 this._emit(`after${eventDetails.type.charAt(0).toUpperCase() + eventDetails.type.slice(1).toLowerCase()}`, eventArg1, eventArg2);
            }

            this._triggerCheckpointIfRequired(`Data Modification (${finalWalEntry.op})`);
            
            return result;
        }, `Data Modification (${finalWalEntry.op} for ID: ${finalWalEntry.id || (finalWalEntry.doc && finalWalEntry.doc._id) || 'N/A'})`);
    }

    async _ensureInitialized() {
        if (!this.initPromise) {
            const msg = `Collection ('${this.collectionName}'): Критическая ошибка - initPromise отсутствует. Конструктор мог не завершиться.`;
            console.error(msg);
            throw new Error(msg);
        }
        await this.initPromise; 
        if (!this.isInitialized) {
            const msg = `Collection ('${this.collectionName}'): Инициализация не удалась (isInitialized=false), но initPromise разрешился. Это не должно происходить.`;
            // Эта ситуация может возникнуть, если initPromise был перехвачен и разрешен где-то выше, несмотря на ошибку.
            // Но в нашей текущей схеме initPromise должен быть отклонен при ошибке.
            console.error(msg);
            throw new Error(msg); 
        }
    }

    _emit(eventName, ...args) {
        const listeners = this._listeners[eventName];
        if (listeners && listeners.length > 0) {
            listeners.forEach(listener => {
                try {
                    Promise.resolve(listener(...args.filter(arg => arg !== undefined))) 
                        .catch(listenerError => {
                        console.error(`Collection ('${this.collectionName}') Event Listener Error (event: '${eventName}'): ${listenerError.message}`, listenerError.stack);
                    });
                } catch (syncError) { 
                    console.error(`Collection ('${this.collectionName}') Event Listener Error (event: '${eventName}'): Синхронная ошибка при вызове: ${syncError.message}`, syncError.stack);
                }
            });
        }
    }
        
    on(eventName, listener) {
        if (typeof listener !== 'function') {
            throw new Error(`Collection ('${this.collectionName}'): Слушатель для события '${eventName}' должен быть функцией.`);
        }
        if (!this._listeners[eventName]) {
            this._listeners[eventName] = [];
        }
        this._listeners[eventName].push(listener);
    }

    off(eventName, listener) {
        if (!this._listeners[eventName]) {
            return;
        }
        if (!listener) {
            delete this._listeners[eventName];
        } else {
            this._listeners[eventName] = this._listeners[eventName].filter(l => l !== listener);
            if (this._listeners[eventName].length === 0) {
                delete this._listeners[eventName];
            }
        }
    }
    
    async insert(dataObject) {
        await this._ensureInitialized();
        if (!dataObject || typeof dataObject !== 'object' || Array.isArray(dataObject)) {
            throw new Error(`Collection ('${this.collectionName}'): dataObject для insert должен быть объектом.`);
        }
        
        const docId = (typeof dataObject._id === 'string' && dataObject._id.length > 0) 
            ? dataObject._id 
            : this.options.idGenerator();
        const ts = new Date().toISOString();

        const newDoc = { 
            ...dataObject, 
            _id: docId,    
            createdAt: typeof dataObject.createdAt === 'string' ? dataObject.createdAt : ts,
            updatedAt: typeof dataObject.updatedAt === 'string' ? dataObject.updatedAt : ts,
        };

        const walEntry = { op: 'INSERT', doc: { ...newDoc } }; // ts будет добавлен в _enqueueDataModification

        return this._enqueueDataModification(
            walEntry, 
            () => { 
                // _applyWalEntryToMemory уже была вызвана. newDoc содержит финальное состояние.
                return { ...newDoc }; 
            },
            { type: 'INSERT', doc: { ...newDoc } } 
        );
    }

    async getById(id) {
        await this._ensureInitialized();
        if (typeof id !== 'string' || id.length === 0) return null;
        const doc = this.documents.get(id);
        return doc ? { ...doc } : null; 
    }

    async getAll() {
        await this._ensureInitialized();
        return Array.from(this.documents.values()).map(doc => ({ ...doc }));
    }

    async find(queryFunction) {
        await this._ensureInitialized();
        if (typeof queryFunction !== 'function') {
            throw new Error(`Collection ('${this.collectionName}'): queryFunction для find должен быть функцией.`);
        }
        const results = [];
        for (const doc of this.documents.values()) {
            if (queryFunction(doc)) { 
                results.push({ ...doc }); 
            }
        }
        return results;
    }
    
    async findOne(queryFunction) {
        await this._ensureInitialized();
         if (typeof queryFunction !== 'function') {
            throw new Error(`Collection ('${this.collectionName}'): queryFunction для findOne должен быть функцией.`);
        }
        for (const doc of this.documents.values()) {
            if (queryFunction(doc)) { 
                return { ...doc }; 
            }
        }
        return null;
    }

    async update(id, updates) {
        await this._ensureInitialized();
        if (typeof id !== 'string' || id.length === 0) {
             throw new Error(`Collection ('${this.collectionName}'): ID для update должен быть непустой строкой.`);
        }
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            throw new Error(`Collection ('${this.collectionName}'): updates для update должен быть объектом.`);
        }

        // Проверяем, существует ли документ до постановки в очередь, чтобы избежать лишних WAL записей
        if (!this.documents.has(id)) {
            return null;
        }

        const cleanUpdates = { ...updates }; 
        delete cleanUpdates._id; 
        delete cleanUpdates.createdAt;
        
        const updateTimestamp = new Date().toISOString();
        cleanUpdates.updatedAt = updateTimestamp; // Явно устанавливаем updatedAt для данных, идущих в WAL

        const walEntry = { op: 'UPDATE', id, data: cleanUpdates }; // ts будет добавлен позже

        return this._enqueueDataModification(
            walEntry,
            () => { 
                // _applyWalEntryToMemory уже была вызвана.
                const updatedDoc = this.documents.get(id); 
                // Если документ был удален другой операцией между проверкой has(id) и этим моментом,
                // то updatedDoc будет undefined. _applyWalEntryToMemory для UPDATE не создаст документ.
                return updatedDoc ? { ...updatedDoc } : null; 
            },
            { type: 'UPDATE', id } 
        );
    }

    async remove(id) {
        await this._ensureInitialized();
        if (typeof id !== 'string' || id.length === 0) {
             throw new Error(`Collection ('${this.collectionName}'): ID для remove должен быть непустой строкой.`);
        }
        
        // Проверяем существование до постановки в очередь для оптимизации
        if (!this.documents.has(id)) {
            return false;
        }

        const walEntry = { op: 'REMOVE', id }; // ts будет добавлен позже

        return this._enqueueDataModification(
            walEntry,
            (oldSnapshotBeforeApply) => { 
                // oldSnapshotBeforeApply содержит документ, если он был.
                // _applyWalEntryToMemory УЖЕ удалила его из this.documents.
                return !!oldSnapshotBeforeApply; // Возвращаем true, если документ существовал до удаления.
            },
            { type: 'REMOVE', id }
        );
    }

    async count(queryFunction) {
        await this._ensureInitialized();
        if (queryFunction === undefined) {
            return this.documents.size;
        }
        if (typeof queryFunction !== 'function') {
             throw new Error(`Collection ('${this.collectionName}'): queryFunction для count должен быть функцией.`);
        }
        let count = 0;
        for (const doc of this.documents.values()) {
            if (queryFunction(doc)) {
                count++;
            }
        }
        return count;
    }
    
    async upsert(query, dataToUpsert, upsertOptions = {}) {
        await this._ensureInitialized();
        if (!query || (typeof query !== 'object' && typeof query !== 'function')) {
            throw new Error(`Collection ('${this.collectionName}'): query для upsert должен быть объектом или функцией.`);
        }
        if (!dataToUpsert || typeof dataToUpsert !== 'object' || Array.isArray(dataToUpsert)) {
            throw new Error(`Collection ('${this.collectionName}'): dataToUpsert для upsert должен быть объектом.`);
        }

        return this._enqueueInternalOperation(async () => {
            const queryFn = typeof query === 'function' ? query : (doc =>
                Object.keys(query).every(key => doc[key] === query[key])
            );
            
            let existingDocumentEntry = null; // [id, doc]
            for (const entry of this.documents.entries()) {
                if (queryFn(entry[1])) { 
                    existingDocumentEntry = entry;
                    break;
                }
            }

            const ts = new Date().toISOString();
            let operationResult;
            let finalWalEntry;
            let eventDetails;
            let oldDocSnapshotForEvent = null;

            if (existingDocumentEntry) { 
                const existingId = existingDocumentEntry[0];
                const existingDoc = existingDocumentEntry[1];
                oldDocSnapshotForEvent = { ...existingDoc };

                const updatesToApply = { ...dataToUpsert };
                delete updatesToApply._id; 
                delete updatesToApply.createdAt;
                updatesToApply.updatedAt = ts; 

                finalWalEntry = { op: 'UPDATE', id: existingId, data: { ...updatesToApply }, ts };
                
                this._applyWalEntryToMemory(finalWalEntry, true);
                const updatedDocInMemory = this.documents.get(existingId); 
                
                operationResult = { document: { ...updatedDocInMemory }, operation: 'updated' };
                eventDetails = { type: 'UPDATE', doc: updatedDocInMemory };

            } else { 
                let docToInsert = {};
                if (typeof query === 'object' && query !== null && !Array.isArray(query)) {
                    docToInsert = { ...query }; 
                }
                docToInsert = { ...docToInsert, ...dataToUpsert }; 
                if (upsertOptions && upsertOptions.setOnInsert && typeof upsertOptions.setOnInsert === 'object') {
                    docToInsert = { ...docToInsert, ...upsertOptions.setOnInsert }; 
                }

                docToInsert._id = (typeof docToInsert._id === 'string' && docToInsert._id.length > 0) 
                    ? docToInsert._id 
                    : this.options.idGenerator();
                docToInsert.createdAt = (typeof docToInsert.createdAt === 'string') ? docToInsert.createdAt : ts;
                docToInsert.updatedAt = ts;
                
                finalWalEntry = { op: 'INSERT', doc: { ...docToInsert }, ts };
                
                this._applyWalEntryToMemory(finalWalEntry, true);
                const insertedDocInMemory = this.documents.get(docToInsert._id); 

                operationResult = { document: { ...insertedDocInMemory }, operation: 'inserted' };
                eventDetails = { type: 'INSERT', doc: insertedDocInMemory };
            }
            
            await WalManager.appendToWal(this.walPath, finalWalEntry, this.options.walForceSync);
            this.walEntriesCountSinceLastCheckpoint++;

            if (eventDetails.type === 'INSERT' && eventDetails.doc) {
                this._emit('afterInsert', eventDetails.doc);
            } else if (eventDetails.type === 'UPDATE' && eventDetails.doc) {
                this._emit('afterUpdate', eventDetails.doc, oldDocSnapshotForEvent);
            }
            
            this._triggerCheckpointIfRequired('Upsert Operation');
            return operationResult;

        }, 'Upsert Operation');
    }

    async clear() {
        await this._ensureInitialized();
        const walEntry = { op: 'CLEAR' };
        return this._enqueueDataModification(
            walEntry,
            () => { /* _applyWalEntryToMemory уже очистила this.documents */ },
            { type: 'CLEAR' }
        );
    }
    
    async getCollectionStats() {
        await this._ensureInitialized();
        let walSizeBytes = 0;
        let walExists = false;
        try {
            if (await StorageUtils.pathExists(this.walPath)) {
                walExists = true;
                const stats = await fs.stat(this.walPath);
                walSizeBytes = stats.size;
            }
        } catch (e) { /* ignore */ }

        return {
            collectionName: this.collectionName,
            documentCount: this.documents.size,
            isInitialized: this.isInitialized,
            walPath: this.walPath,
            walExists,
            walSizeBytes,
            walEntriesSinceLastCheckpoint: this.walEntriesCountSinceLastCheckpoint,
            checkpointsPath: this.checkpointsDirPath,
            lastCheckpointTimestamp: this.lastCheckpointTimestamp,
            options: { ...this.options } 
        };
    }
    
    async save() {
        await this._ensureInitialized();
        return this._enqueueInternalOperation(async () => {
            if (this.isCheckpointScheduledOrRunning) {
                console.log(`Collection ('${this.collectionName}'): Ручной вызов save(), но чекпоинт уже запланирован или выполняется. Новый чекпоинт не будет запущен.`);
                return this.lastCheckpointTimestamp; 
            }
            // Выполняем чекпоинт, если были изменения с последнего чекпоинта,
            // или если чекпоинтов еще не было (даже для пустой коллекции),
            // ИЛИ если есть документы в памяти (на случай, если walEntriesCount был сброшен ошибкой, но данные есть).
            if (this.walEntriesCountSinceLastCheckpoint > 0 || !this.lastCheckpointTimestamp || (this.documents.size > 0 && !this.lastCheckpointTimestamp) ) {
                this.isCheckpointScheduledOrRunning = true;
                try {
                    return await this._performCheckpoint();
                } finally {
                    this.isCheckpointScheduledOrRunning = false;
                }
            } else {
                console.log(`Collection ('${this.collectionName}'): Ручной вызов save(), нет новых WAL записей для чекпоинта или коллекция пуста и уже есть чекпоинт. Последний чекпоинт: ${this.lastCheckpointTimestamp}`);
                return this.lastCheckpointTimestamp; 
            }
        }, 'Manual Save (Checkpoint)');
    }

    async close() {
        console.log(`Collection ('${this.collectionName}'): Попытка закрытия... Ожидание очереди операций.`);
        
        const finalOperationPromise = this._enqueueInternalOperation(async () => {
            // На момент выполнения этой операции в очереди, this.isInitialized должно быть true,
            // если _ensureInitialized в _enqueueInternalOperation отработал успешно.
            // Если инициализация упала, _ensureInitialized перебросит ошибку, и мы сюда не дойдем.

            console.log(`Collection ('${this.collectionName}'): Очередь операций достигла операции закрытия. Приступаем к закрытию.`);
            if (this.checkpointTimerId) {
                clearInterval(this.checkpointTimerId);
                this.checkpointTimerId = null;
                console.log(`Collection ('${this.collectionName}'): Таймер автоматических чекпоинтов остановлен.`);
            }

            if (this.isInitialized) { 
                if (this.walEntriesCountSinceLastCheckpoint > 0 || (!this.lastCheckpointTimestamp && (this.documents.size > 0 || await StorageUtils.pathExists(this.walPath) && (await fs.stat(this.walPath)).size > 0) )) {
                    if (!this.isCheckpointScheduledOrRunning) {
                        this.isCheckpointScheduledOrRunning = true;
                        try {
                            console.log(`Collection ('${this.collectionName}'): Выполнение финального чекпоинта при закрытии.`);
                            await this._performCheckpoint();
                        } catch (err) {
                            console.error(`Collection ('${this.collectionName}'): Ошибка при выполнении финального чекпоинта во время закрытия: ${err.message}`);
                        } finally {
                             this.isCheckpointScheduledOrRunning = false;
                        }
                    } else {
                        console.warn(`Collection ('${this.collectionName}'): Финальный чекпоинт пропущен при закрытии, т.к. другой чекпоинт уже выполняется/запланирован.`);
                    }
                } else {
                    console.log(`Collection ('${this.collectionName}'): Нет несохраненных изменений, финальный чекпоинт не требуется при закрытии.`);
                }
            } else {
                 console.log(`Collection ('${this.collectionName}'): Коллекция не была полностью инициализирована, финальный чекпоинт при закрытии пропущен.`);
            }
            
            this.isInitialized = false; 
            this.documents.clear(); 
            // После закрытия, initPromise должен указывать на то, что коллекция не готова.
            // Создаем новый отклоненный промис или промис, который говорит, что она закрыта.
            this.initPromise = Promise.reject(new Error(`Collection ('${this.collectionName}') is closed.`));
            this.initPromise.catch(()=>{}); // Подавляем UnhandledPromiseRejectionWarning для этого специального промиса
            console.log(`Collection ('${this.collectionName}'): initPromise установлен в rejected state.`);
            console.log(`Collection ('${this.collectionName}'): Коллекция успешно закрыта (ресурсы освобождены).`);
        }, 'Close Collection');

        try {
            await finalOperationPromise;
        } catch(err) {
            console.error(`Collection ('${this.collectionName}'): Ошибка в процессе операции закрытия коллекции: ${err.message}`);
            // Убедимся, что состояние отражает неудачное закрытие или невозможность дальнейшей работы
            this.isInitialized = false; 
            this.documents.clear();
            if (this.checkpointTimerId) clearInterval(this.checkpointTimerId);
            this.initPromise = Promise.reject(err); // Обновляем initPromise на ошибку закрытия
            this.initPromise.catch(()=>{}); 
            throw err; // Перебрасываем ошибку дальше
        }
    }
}

module.exports = Collection;