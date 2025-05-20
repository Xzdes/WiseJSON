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
            
            // TODO: На этом этапе, после загрузки документов и WAL, если есть метаданные об индексах,
            // которые должны были быть загружены (например, из файла .meta коллекции или чекпоинта),
            // нужно автоматически перестроить эти индексы здесь, вызвав createIndex для каждого.
            // for (const indexMeta of loadedIndexMetas) {
            //    await this.createIndex(indexMeta.fieldName, { unique: indexMeta.unique });
            // }

            this._setupAutomaticCheckpoints();
            
            CheckpointManager.cleanupOldCheckpoints(this.checkpointsDirPath, this.collectionName, this.options.checkpointsToKeep)
                .catch(err => console.error(`Collection ('${this.collectionName}'): Ошибка при фоновой очистке старых чекпоинтов во время инициализации: ${err.message}`));

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
        // ВАЖНО: На этом этапе этот метод НЕ обновляет пользовательские индексы.
        // Он только применяет изменения к this.documents.
        // Обновление индексов будет добавлено в _enqueueDataModification или в самом этом методе позже.
        if (!entry || typeof entry.op !== 'string') {
            console.warn(`Collection ('${this.collectionName}'): Пропущена некорректная WAL-подобная запись (отсутствует 'op'): ${JSON.stringify(entry)}`);
            return;
        }
        
        const opTimestamp = entry.ts || (isLiveOperation ? new Date().toISOString() : null);
        if (!opTimestamp && isLiveOperation && entry.op !== 'CLEAR') {
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
                        docToStore.createdAt = entry.doc.createdAt || opTimestamp;
                        docToStore.updatedAt = entry.doc.updatedAt || opTimestamp;
                    }
                    this.documents.set(docToStore._id, docToStore);
                } else {
                     console.warn(`Collection ('${this.collectionName}'): Пропущена INSERT запись из-за отсутствия 'doc' или 'doc._id': ${JSON.stringify(entry)}`);
                }
                break;
            case 'UPDATE':
                if (typeof entry.id === 'string' && entry.data && typeof entry.data === 'object') {
                    if (this.documents.has(entry.id)) {
                        const existingDoc = this.documents.get(entry.id);
                        const updatedDoc = { ...existingDoc, ...entry.data };
                        
                        if (entry.data.updatedAt) { 
                            updatedDoc.updatedAt = entry.data.updatedAt;
                        } else if (opTimestamp) { 
                            updatedDoc.updatedAt = opTimestamp;
                        }
                        this.documents.set(entry.id, updatedDoc);
                    }
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
        
        const walToProcessPath = await WalManager.prepareWalForCheckpoint(this.walPath, checkpointAttemptTs);
        // const walCountForThisCheckpoint = await WalManager.readWal(walToProcessPath).then(ops => ops.length); // Это было для лога, можно убрать
        console.log(`Collection ('${this.collectionName}'): Начало выполнения чекпоинта (ts: ${checkpointAttemptTs}). WAL для обработки: "${path.basename(walToProcessPath)}".`);
        
        try {
            const checkpointMetaInput = {
                timestamp: checkpointAttemptTs, // Точная временная метка начала чекпоинта
                // TODO: На следующем этапе: добавить сюда метаданные об индексах
                // indexes: Array.from(this.indexes.values()).map(idx => ({ fieldName: idx.fieldName, type: idx.type, unique: idx.type === 'unique' }))
            };

            const checkpointMetaResult = await CheckpointManager.performCheckpoint(
                this.checkpointsDirPath,
                this.collectionName,
                documentsSnapshot, 
                checkpointMetaInput.timestamp, // Используем timestamp из checkpointMetaInput
                this.options
                // TODO: На следующем этапе: передать checkpointMetaInput, чтобы он был сохранен
            );

            // TODO: На следующем этапе: если индексы сохраняются на диск, сделать это здесь.
            // for (const [fieldName, indexDef] of this.indexes.entries()) {
            //    await IndexPersistenceManager.saveIndex(this.checkpointsDirPath, fieldName, indexDef.data);
            // }

            const opsMoved = await WalManager.finalizeWalAfterCheckpoint(
                this.walPath, 
                walToProcessPath, 
                checkpointMetaResult.timestamp, // Используем timestamp из результата чекпоинта
                this.options.walForceSync
            );
            
            this.lastCheckpointTimestamp = checkpointMetaResult.timestamp; 
            const remainingWalOpsAfterFinalize = await WalManager.readWal(this.walPath, this.lastCheckpointTimestamp);
            this.walEntriesCountSinceLastCheckpoint = remainingWalOpsAfterFinalize.length;

            console.log(`Collection ('${this.collectionName}'): Чекпоинт успешно создан (meta: ${checkpointMetaResult.metaFile}, ts: ${checkpointMetaResult.timestamp}). WAL обработан, перенесено ${opsMoved} операций. Текущих WAL записей: ${this.walEntriesCountSinceLastCheckpoint}.`);

             CheckpointManager.cleanupOldCheckpoints(this.checkpointsDirPath, this.collectionName, this.options.checkpointsToKeep)
                .catch(err => console.error(`Collection ('${this.collectionName}'): Ошибка при фоновой очистке старых чекпоинтов: ${err.message}`));

            return checkpointMetaResult.timestamp;
        } catch (error) {
            const errorMessage = `Collection ('${this.collectionName}') ERROR: Критическая ошибка во время выполнения чекпоинта (попытка ts: ${checkpointAttemptTs}): ${error.message}`;
            console.error(errorMessage, error.stack);
            if (await StorageUtils.pathExists(walToProcessPath)) {
                console.warn(`Collection ('${this.collectionName}'): Чекпоинт не удался. Временный WAL "${walToProcessPath}" не был обработан.`);
            }
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
                this.checkpointTimerId.unref();
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
            
        this.writeQueue = promise.catch(err => {});
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

            // TODO: На следующем этапе, здесь нужно будет обновить индексы *ДО* записи в WAL,
            // если операция может нарушить уникальность индекса.
            // Если проверка уникальности не пройдена, бросить ошибку и не писать в WAL.

            await WalManager.appendToWal(this.walPath, finalWalEntry, this.options.walForceSync);
            this.walEntriesCountSinceLastCheckpoint++;
            
            this._applyWalEntryToMemory(finalWalEntry, true); 
            
            // TODO: На следующем этапе, здесь (или в _applyWalEntryToMemory) нужно обновить
            // не-уникальные индексы или уникальные, если проверка пройдена.

            const result = applyToMemoryAndReturnResultFn(oldDocSnapshot); 

            if (eventDetails) {
                let eventArg1 = result, eventArg2; 
                if (eventDetails.type === 'INSERT') eventArg1 = result; 
                else if (eventDetails.type === 'UPDATE') { eventArg1 = result; eventArg2 = oldDocSnapshot; }
                else if (eventDetails.type === 'REMOVE') { eventArg1 = eventDetails.id; eventArg2 = oldDocSnapshot; if (!result) return result; }
                this._emit(`after${eventDetails.type.charAt(0).toUpperCase() + eventDetails.type.slice(1).toLowerCase()}`, eventArg1, eventArg2);
            }

            this._triggerCheckpointIfRequired(`Data Modification (${finalWalEntry.op})`);
            
            return result;
        }, `Data Modification (${finalWalEntry.op} for ID: ${finalWalEntry.id || (finalWalEntry.doc && finalWalEntry.doc._id) || 'N/A'})`);
    }

    async _ensureInitialized() {
        if (!this.initPromise) {
            const msg = `Collection ('${this.collectionName}'): Критическая ошибка - initPromise отсутствует.`;
            console.error(msg);
            throw new Error(msg);
        }
        await this.initPromise; 
        if (!this.isInitialized) {
            const msg = `Collection ('${this.collectionName}'): Инициализация не удалась (isInitialized=false), но initPromise разрешился.`;
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

        // TODO INDEXING: Если есть уникальные индексы, здесь нужна проверка ПЕРЕД _enqueueDataModification
        // if (this._violatesUniqueIndexOnInsert(newDoc)) {
        //    throw new Error(`Нарушение уникального индекса при вставке.`);
        // }

        const walEntry = { op: 'INSERT', doc: { ...newDoc } };

        return this._enqueueDataModification(
            walEntry, 
            () => ({ ...newDoc }),
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
        // TODO INDEXING: Здесь можно будет добавить логику использования индексов, если queryFunction
        // можно проанализировать или если это объект запроса. Пока полный скан.
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
        // TODO INDEXING: Аналогично find.
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

        const currentDoc = this.documents.get(id);
        if (!currentDoc) {
            return null; 
        }

        const cleanUpdates = { ...updates }; 
        delete cleanUpdates._id; 
        delete cleanUpdates.createdAt;
        
        const updateTimestamp = new Date().toISOString();
        cleanUpdates.updatedAt = updateTimestamp; 

        // TODO INDEXING: Если есть уникальные индексы, и обновляемые поля их затрагивают,
        // здесь нужна проверка ПЕРЕД _enqueueDataModification.
        // const potentialUpdatedDoc = { ...currentDoc, ...cleanUpdates };
        // if (this._violatesUniqueIndexOnUpdate(currentDoc, potentialUpdatedDoc)) {
        //    throw new Error(`Нарушение уникального индекса при обновлении.`);
        // }

        const walEntry = { op: 'UPDATE', id, data: cleanUpdates };

        return this._enqueueDataModification(
            walEntry,
            () => { 
                const updatedDoc = this.documents.get(id); 
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
        
        // oldSnapshot будет получен внутри _enqueueDataModification
        const walEntry = { op: 'REMOVE', id };
        return this._enqueueDataModification(
            walEntry,
            (oldSnapshotBeforeApply) => !!oldSnapshotBeforeApply,
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
            
            let existingDocumentEntry = null; 
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

                // TODO INDEXING: Проверка уникальности для updatesToApply, если нужно
                // const potentialUpdatedDoc = { ...existingDoc, ...updatesToApply };
                // if (this._violatesUniqueIndexOnUpdate(existingDoc, potentialUpdatedDoc)) { /* throw */ }


                finalWalEntry = { op: 'UPDATE', id: existingId, data: { ...updatesToApply }, ts };
                this._applyWalEntryToMemory(finalWalEntry, true);
                // TODO INDEXING: Обновить индексы для UPDATE
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

                // TODO INDEXING: Проверка уникальности для docToInsert, если нужно
                // if (this._violatesUniqueIndexOnInsert(docToInsert)) { /* throw */ }
                
                finalWalEntry = { op: 'INSERT', doc: { ...docToInsert }, ts };
                this._applyWalEntryToMemory(finalWalEntry, true);
                // TODO INDEXING: Обновить индексы для INSERT
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
            () => {
                // TODO INDEXING: Очистить все индексы
                // this.indexes.forEach(indexDef => indexDef.data.clear());
            },
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

        const indexInfo = Array.from(this.indexes.values()).map(idx => ({
            fieldName: idx.fieldName,
            type: idx.type,
            size: idx.data.size 
        }));

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
            indexes: indexInfo, // Добавляем информацию об индексах
            options: { ...this.options } 
        };
    }
    
    async save() {
        await this._ensureInitialized();
        return this._enqueueInternalOperation(async () => {
            if (this.isCheckpointScheduledOrRunning) {
                console.log(`Collection ('${this.collectionName}'): Ручной вызов save(), но чекпоинт уже запланирован или выполняется.`);
                return this.lastCheckpointTimestamp; 
            }
            if (this.walEntriesCountSinceLastCheckpoint > 0 || !this.lastCheckpointTimestamp || (this.documents.size > 0 && !this.lastCheckpointTimestamp) ) {
                this.isCheckpointScheduledOrRunning = true;
                try {
                    return await this._performCheckpoint();
                } finally {
                    this.isCheckpointScheduledOrRunning = false;
                }
            } else {
                console.log(`Collection ('${this.collectionName}'): Ручной вызов save(), нет новых WAL записей для чекпоинта.`);
                return this.lastCheckpointTimestamp; 
            }
        }, 'Manual Save (Checkpoint)');
    }

    async close() {
        console.log(`Collection ('${this.collectionName}'): Попытка закрытия... Ожидание очереди операций.`);
        const finalOperationPromise = this._enqueueInternalOperation(async () => {
            console.log(`Collection ('${this.collectionName}'): Очередь операций достигла операции закрытия. Приступаем к закрытию.`);
            if (this.checkpointTimerId) {
                clearInterval(this.checkpointTimerId);
                this.checkpointTimerId = null;
                console.log(`Collection ('${this.collectionName}'): Таймер автоматических чекпоинтов остановлен.`);
            }

            let closedGracefully = false;
            if (this.isInitialized) { 
                const hasPendingWalData = this.walEntriesCountSinceLastCheckpoint > 0;
                const noCheckpointsYet = !this.lastCheckpointTimestamp;
                const hasDataInMemory = this.documents.size > 0;
                let walFileExistsAndNotEmpty = false;
                if (await StorageUtils.pathExists(this.walPath)) {
                    try { walFileExistsAndNotEmpty = (await fs.stat(this.walPath)).size > 0; } catch(e) {/*ignore*/}
                }
                let needsCheckpoint = hasPendingWalData || (noCheckpointsYet && (hasDataInMemory || walFileExistsAndNotEmpty) );
                
                if (needsCheckpoint) {
                    if (!this.isCheckpointScheduledOrRunning) {
                        this.isCheckpointScheduledOrRunning = true;
                        try {
                            console.log(`Collection ('${this.collectionName}'): Выполнение финального чекпоинта при закрытии.`);
                            await this._performCheckpoint();
                            closedGracefully = true; 
                        } catch (err) {
                            console.error(`Collection ('${this.collectionName}'): Ошибка при выполнении финального чекпоинта во время закрытия: ${err.message}`);
                        } finally {
                             this.isCheckpointScheduledOrRunning = false;
                        }
                    } else {
                        console.warn(`Collection ('${this.collectionName}'): Финальный чекпоинт пропущен при закрытии, т.к. другой чекпоинт уже выполняется/запланирован.`);
                    }
                } else {
                    console.log(`Collection ('${this.collectionName}'): Нет несохраненных изменений или чекпоинт не требуется, финальный чекпоинт не выполняется.`);
                    closedGracefully = true;
                }
            } else {
                 console.log(`Collection ('${this.collectionName}'): Коллекция не была полностью инициализирована, финальный чекпоинт при закрытии пропущен.`);
                 closedGracefully = true; 
            }
            
            this.isInitialized = false; 
            this.documents.clear(); 
            this.indexes.clear(); // Очищаем индексы в памяти
            this.indexedFields.clear();
            const closedError = new Error(`Collection ('${this.collectionName}') is closed.`);
            this.initPromise = Promise.reject(closedError);
            this.initPromise.catch(()=>{}); 
            
            console.log(`Collection ('${this.collectionName}'): Коллекция ${closedGracefully ? 'успешно' : 'принудительно'} закрыта (ресурсы освобождены).`);
        }, 'Close Collection');

        try {
            await finalOperationPromise;
        } catch(err) {
            console.error(`Collection ('${this.collectionName}'): Общая ошибка в процессе операции закрытия коллекции: ${err.message}`);
            this.isInitialized = false; 
            this.documents.clear();
            this.indexes.clear();
            this.indexedFields.clear();
            if (this.checkpointTimerId) clearInterval(this.checkpointTimerId);
            const finalError = err.operationName === 'Close Collection' ? err : new Error(`Collection ('${this.collectionName}') failed to close: ${err.message}`);
            this.initPromise = Promise.reject(finalError); 
            this.initPromise.catch(()=>{}); 
            throw finalError; 
        }
    }

    // --- МЕТОДЫ ДЛЯ УПРАВЛЕНИЯ ИНДЕКСАМИ (Базовая реализация) ---

    async createIndex(fieldName, options = {}) {
        await this._ensureInitialized();
        if (typeof fieldName !== 'string' || fieldName.trim() === '') {
            throw new Error(`Collection ('${this.collectionName}'): Имя поля для индекса должно быть непустой строкой.`);
        }

        const isUnique = !!options.unique;

        return this._enqueueInternalOperation(async () => {
            console.log(`Collection ('${this.collectionName}'): Создание/перестроение ${isUnique ? 'уникального' : 'простого'} индекса для поля '${fieldName}'...`);

            const newIndexData = new Map();
            const tempValueSetForUniqueness = isUnique ? new Set() : null;

            for (const [docId, doc] of this.documents.entries()) {
                const value = doc[fieldName]; 

                if (isUnique) {
                    if (value !== undefined && value !== null) { 
                        if (tempValueSetForUniqueness.has(value)) {
                            throw new Error(`Collection ('${this.collectionName}'): Нарушение уникальности при создании индекса по полю '${fieldName}'. Значение: '${value}'.`);
                        }
                        tempValueSetForUniqueness.add(value);
                        newIndexData.set(value, docId); 
                    }
                } else { 
                    let idSet = newIndexData.get(value);
                    if (!idSet) {
                        idSet = new Set();
                        newIndexData.set(value, idSet);
                    }
                    idSet.add(docId);
                }
            }

            this.indexes.set(fieldName, {
                type: isUnique ? 'unique' : 'simple',
                fieldName: fieldName,
                data: newIndexData,
            });
            this.indexedFields.add(fieldName);

            console.log(`Collection ('${this.collectionName}'): ${isUnique ? 'Уникальный' : 'Простой'} индекс для поля '${fieldName}' успешно создан/перестроен. Записей в индексе: ${newIndexData.size}.`);
            // TODO: Сохранить метаданные индекса персистентно
        }, `CreateIndex-${fieldName}`);
    }

    async dropIndex(fieldName) {
        await this._ensureInitialized();
        if (typeof fieldName !== 'string' || fieldName.trim() === '') {
            throw new Error(`Collection ('${this.collectionName}'): Имя поля для удаления индекса должно быть непустой строкой.`);
        }
        
        return this._enqueueInternalOperation(() => {
            if (this.indexes.has(fieldName)) {
                this.indexes.delete(fieldName);
                this.indexedFields.delete(fieldName);
                console.log(`Collection ('${this.collectionName}'): Индекс для поля '${fieldName}' удален.`);
                // TODO: Удалить персистентные метаданные индекса
                return true;
            }
            console.log(`Collection ('${this.collectionName}'): Индекс для поля '${fieldName}' не найден, удаление не требуется.`);
            return false;
        }, `DropIndex-${fieldName}`);
    }

    async getIndexes() {
        await this._ensureInitialized();
        const indexInfo = [];
        for (const [fieldName, indexDef] of this.indexes.entries()) {
            indexInfo.push({
                fieldName: indexDef.fieldName,
                type: indexDef.type,
                // Можно добавить размер: indexDef.data.size
            });
        }
        return indexInfo;
    }

    async findOneByIndexedValue(fieldName, value) {
        await this._ensureInitialized();
        if (!this.indexes.has(fieldName)) {
            console.warn(`Collection ('${this.collectionName}'): Попытка findOneByIndexedValue, но индекс для поля '${fieldName}' не существует.`);
            return null;
        }

        const indexDef = this.indexes.get(fieldName);
        const indexData = indexDef.data; 

        if (indexDef.type === 'unique') {
            const docId = indexData.get(value);
            if (docId) {
                const doc = this.documents.get(docId);
                return doc ? { ...doc } : null;
            }
            return null;
        } else if (indexDef.type === 'simple') {
            const idSet = indexData.get(value);
            if (idSet && idSet.size > 0) {
                const firstId = idSet.values().next().value; 
                const doc = this.documents.get(firstId);
                return doc ? { ...doc } : null;
            }
            return null;
        }
        return null; 
    }

    async findByIndexedValue(fieldName, value) {
        await this._ensureInitialized();
        if (!this.indexes.has(fieldName)) {
            console.warn(`Collection ('${this.collectionName}'): Попытка findByIndexedValue, но индекс для поля '${fieldName}' не существует.`);
            return [];
        }

        const indexDef = this.indexes.get(fieldName);
        const indexData = indexDef.data;
        const results = [];

        if (indexDef.type === 'unique') {
            const docId = indexData.get(value);
            if (docId) {
                const doc = this.documents.get(docId);
                if (doc) results.push({ ...doc });
            }
        } else if (indexDef.type === 'simple') {
            const idSet = indexData.get(value);
            if (idSet) {
                for (const docId of idSet) {
                    const doc = this.documents.get(docId);
                    if (doc) results.push({ ...doc });
                }
            }
        }
        return results;
    }
}

module.exports = Collection;