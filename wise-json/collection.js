// wise-json/collection.js
const fs = require('fs/promises'); // Используется редко, в основном для fs.stat в getCollectionStats
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
            await WalManager.initializeWal(this.walPath, this.collectionDirectoryPath); // Передаем collectionDirectoryPath

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
            // walEntriesCountSinceLastCheckpoint - это количество операций в текущем WAL, которые *еще не* вошли в чекпоинт.
            // Если lastCheckpointTimestamp есть, то appliedWalOpsCount - это именно они.
            // Если lastCheckpointTimestamp нет (нет чекпоинтов), то все записи WAL - "новые" относительно пустого состояния.
            this.walEntriesCountSinceLastCheckpoint = appliedWalOpsCount; 

            console.log(`Collection ('${this.collectionName}'): Применено ${appliedWalOpsCount} операций из WAL. Всего документов в памяти: ${this.documents.size}.`);

            this._setupAutomaticCheckpoints();
            
            // Запускаем очистку старых чекпоинтов асинхронно, не блокируя initPromise
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
        if (!entry || typeof entry.op !== 'string') {
            console.warn(`Collection ('${this.collectionName}'): Пропущена некорректная WAL-подобная запись (отсутствует 'op'): ${JSON.stringify(entry)}`);
            return;
        }
        
        const opTimestamp = entry.ts || (isLiveOperation ? new Date().toISOString() : null);
        if (!opTimestamp && isLiveOperation && entry.op !== 'CLEAR') { // Для CLEAR ts не так важен
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
                    } else {
                        // При восстановлении это может быть нормально, если документ был удален операцией, еще не попавшей в чекпоинт,
                        // но сам UPDATE для уже удаленного документа не должен ничего делать.
                        // console.log(`Collection ('${this.collectionName}'): Документ с ID '${entry.id}' не найден в памяти для операции UPDATE.`);
                    }
                } else {
                    console.warn(`Collection ('${this.collectionName}'): Пропущена UPDATE запись для ID '${entry.id}' (некорректные данные или ID): ${JSON.stringify(entry)}`);
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
        
        // Переименовываем текущий WAL, чтобы новые операции шли в новый файл WAL.
        // walToProcessPath - это WAL, который СООТВЕТСТВУЕТ documentsSnapshot.
        const walToProcessPath = await WalManager.prepareWalForCheckpoint(this.walPath, checkpointAttemptTs);
        const walCountForThisCheckpoint = await WalManager.readWal(walToProcessPath).then(ops => ops.length); // Сколько операций в WAL, идущем в этот чекпоинт

        console.log(`Collection ('${this.collectionName}'): Начало выполнения чекпоинта (ts: ${checkpointAttemptTs}). WAL для обработки: "${path.basename(walToProcessPath)}" (${walCountForThisCheckpoint} записей).`);
        
        try {
            const checkpointMeta = await CheckpointManager.performCheckpoint(
                this.checkpointsDirPath,
                this.collectionName,
                documentsSnapshot, 
                checkpointAttemptTs, // Эта метка соответствует данным в documentsSnapshot
                this.options
            );

            // После успешного сохранения чекпоинта, финализируем WAL.
            // Переносим записи из walToProcessPath, которые новее checkpointMeta.timestamp (т.е. пришли во время чекпоинта),
            // в текущий активный this.walPath.
            // Однако, поскольку мы переименовали WAL *до* создания снимка, все записи в walToProcessPath
            // должны быть *старше или равны* checkpointAttemptTs.
            // Те, что новее чекпоинта, будут уже в новом this.walPath.
            // Поэтому, после успешного чекпоинта, walToProcessPath можно просто удалить.
            // Но для большей надежности, если checkpointMeta.timestamp немного отличается от checkpointAttemptTs,
            // или если мы хотим обработать записи, пришедшие во время самого performCheckpoint, нужна более сложная логика.
            // Текущий WalManager.finalizeWalAfterCheckpoint() пытается перенести "новые" записи из walToProcessPath.
            // Но так как prepareWalForCheckpoint уже отделил "старый" WAL, то в walToProcessPath не должно быть ничего новее checkpointAttemptTs.
            // Значит, finalizeWalAfterCheckpoint должен по сути просто удалить walToProcessPath.
            // Или, если мы хотим быть супер-надежными, он может проверить, есть ли в walToProcessPath записи,
            // которые по какой-то причине новее checkpointMeta.timestamp и дописать их.

            // Упрощенная логика: если чекпоинт успешен, старый WAL (walToProcessPath) больше не нужен в таком виде.
            // Записи, пришедшие во время чекпоинта, уже пишутся в новый this.walPath.
            // `WalManager.finalizeWalAfterCheckpoint` должен удалить `walToProcessPath`.
            // И обновить `this.walEntriesCountSinceLastCheckpoint` на основе нового `this.walPath`.

            const opsMoved = await WalManager.finalizeWalAfterCheckpoint(
                this.walPath, // текущий (возможно, новый/пустой) WAL
                walToProcessPath, // WAL, который был заархивирован
                checkpointMeta.timestamp, // метка сохраненного чекпоинта
                this.options.walForceSync
            );
            
            this.lastCheckpointTimestamp = checkpointMeta.timestamp; 
            // Сбрасываем счетчик, так как все из walToProcessPath либо вошло в чекпоинт, либо перенесено.
            // Новые записи, пришедшие в this.walPath во время чекпоинта, уже будут учтены при следующем инкременте.
            // Правильнее будет установить счетчик в количество операций, реально оставшихся в this.walPath.
            const remainingWalOpsAfterFinalize = await WalManager.readWal(this.walPath, this.lastCheckpointTimestamp);
            this.walEntriesCountSinceLastCheckpoint = remainingWalOpsAfterFinalize.length;


            console.log(`Collection ('${this.collectionName}'): Чекпоинт успешно создан (meta: ${checkpointMeta.metaFile}, ts: ${checkpointMeta.timestamp}). WAL обработан, перенесено ${opsMoved} операций. Текущих WAL записей: ${this.walEntriesCountSinceLastCheckpoint}.`);

             CheckpointManager.cleanupOldCheckpoints(this.checkpointsDirPath, this.collectionName, this.options.checkpointsToKeep)
                .catch(err => console.error(`Collection ('${this.collectionName}'): Ошибка при фоновой очистке старых чекпоинтов: ${err.message}`));

            return checkpointMeta.timestamp;
        } catch (error) {
            const errorMessage = `Collection ('${this.collectionName}') ERROR: Критическая ошибка во время выполнения чекпоинта (попытка ts: ${checkpointAttemptTs}): ${error.message}`;
            console.error(errorMessage, error.stack);
            // Если чекпоинт не удался, walToProcessPath все еще содержит WAL на момент начала чекпоинта.
            // Нужно попытаться восстановить основной WAL из него, если это возможно, или хотя бы не удалять walToProcessPath.
            // Сейчас мы просто бросаем ошибку. Это требует доработки для "пуленепробиваемости".
            // Пока что, если чекпоинт упал, walToProcessPath остается, а this.walPath - это новый WAL.
            // При следующем запуске, если walToProcessPath не обработан, это может вызвать проблемы.
            // Лучше попытаться переименовать walToProcessPath обратно в this.walPath, если this.walPath пуст.
            if (await StorageUtils.pathExists(walToProcessPath)) {
                console.warn(`Collection ('${this.collectionName}'): Чекпоинт не удался. Временный WAL "${walToProcessPath}" не был обработан.`);
                // Попытка восстановить:
                // const currentWalIsEmpty = !(await StorageUtils.pathExists(this.walPath)) || (await fs.stat(this.walPath)).size === 0;
                // if (currentWalIsEmpty) {
                //    try { await fs.rename(walToProcessPath, this.walPath); console.log(`Восстановлен WAL из ${walToProcessPath}`); } catch (e) {}
                // }
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
                    // No specific args
                }
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
                    console.error(`Collection ('${this.collectionName}') Event Listener Error (event: '${eventName}'): Синхронная ошибка: ${syncError.message}`, syncError.stack);
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

        const walEntry = { op: 'INSERT', doc: { ...newDoc } };

        return this._enqueueDataModification(
            walEntry, 
            () => ({ ...newDoc }), // Возвращаем копию нового документа
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

        // Оптимистичная проверка перед постановкой в очередь
        if (!this.documents.has(id)) {
            return null; 
        }

        const cleanUpdates = { ...updates }; 
        delete cleanUpdates._id; 
        delete cleanUpdates.createdAt;
        
        const updateTimestamp = new Date().toISOString();
        cleanUpdates.updatedAt = updateTimestamp; 

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
        
        // Оптимистичная проверка перед постановкой в очередь
        if (!this.documents.has(id)) {
            return false;
        }

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

                finalWalEntry = { op: 'UPDATE', id: existingId, data: { ...updatesToApply }, ts }; // ts здесь для WAL записи
                
                this._applyWalEntryToMemory(finalWalEntry, true); // true т.к. живая операция
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
                
                finalWalEntry = { op: 'INSERT', doc: { ...docToInsert }, ts }; // ts здесь для WAL записи
                
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
        const walEntry = { op: 'CLEAR' }; // ts будет добавлен в _enqueueDataModification
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
        } catch (e) { /* ignore, e.g. file just deleted */ }

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
            console.log(`Collection ('${this.collectionName}'): Очередь операций достигла операции закрытия. Приступаем к закрытию.`);
            if (this.checkpointTimerId) {
                clearInterval(this.checkpointTimerId);
                this.checkpointTimerId = null;
                console.log(`Collection ('${this.collectionName}'): Таймер автоматических чекпоинтов остановлен.`);
            }

            let closedGracefully = false;
            if (this.isInitialized) { 
                // Финальный чекпоинт, если есть несохраненные изменения или это первый чекпоинт для пустой коллекции с WAL
                const hasPendingWalData = this.walEntriesCountSinceLastCheckpoint > 0;
                const noCheckpointsYet = !this.lastCheckpointTimestamp;
                const hasDataInMemory = this.documents.size > 0;
                let needsCheckpoint = hasPendingWalData || (noCheckpointsYet && (hasDataInMemory || (await StorageUtils.pathExists(this.walPath) && (await fs.stat(this.walPath)).size > 0) ));
                
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
            if (this.checkpointTimerId) clearInterval(this.checkpointTimerId);
            const finalError = err.operationName === 'Close Collection' ? err : new Error(`Collection ('${this.collectionName}') failed to close: ${err.message}`);
            this.initPromise = Promise.reject(finalError); 
            this.initPromise.catch(()=>{}); 
            throw finalError; 
        }
    }
}

module.exports = Collection;