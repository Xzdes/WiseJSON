// wise-json/collection.js
const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_MAX_SEGMENT_SIZE_BYTES = 1 * 1024 * 1024; // 1MB
const DEFAULT_JSON_INDENT = 2; // 2 пробела для форматирования, null для компактного JSON

class Collection {
    constructor(collectionName, dbDirectoryPath, options = {}) {
        this.collectionName = collectionName;
        this.collectionDirectoryPath = path.join(dbDirectoryPath, collectionName);
        this.options = {
            maxSegmentSizeBytes: options.maxSegmentSizeBytes || DEFAULT_MAX_SEGMENT_SIZE_BYTES,
            jsonIndent: options.jsonIndent !== undefined ? options.jsonIndent : DEFAULT_JSON_INDENT,
            idGenerator: options.idGenerator || (() => uuidv4())
        };

        this.currentSegmentIndex = 0;
        this.writeQueue = Promise.resolve();
        this.isInitialized = false;
        this.initPromise = this._initializeAndRecover();
        this._listeners = {};
    }

    async _pathExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async _isValidJsonFile(filePath) {
        if (!(await this._pathExists(filePath))) {
            return false;
        }
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            JSON.parse(content);
            return true;
        } catch {
            return false;
        }
    }
    
    async _initializeAndRecover() {
        try {
            await fs.mkdir(this.collectionDirectoryPath, { recursive: true });
            await this._recoverSegments(); 
            
            const segmentFiles = await this._getActualSegmentFiles();

            if (segmentFiles.length > 0) {
                const lastSegmentName = segmentFiles[segmentFiles.length - 1];
                const determinedIndex = this._getSegmentIndexFromName(lastSegmentName);

                if (determinedIndex === -1) {
                    // Эта ситуация маловероятна, если _getActualSegmentFiles возвращает корректно отсортированные и отфильтрованные .json файлы.
                    // Может произойти, если имя последнего файла сегмента как-то повреждено, но все же прошло через фильтры.
                    console.warn(`WiseJSON WARN (_initializeAndRecover): Не удалось определить currentSegmentIndex для коллекции "${this.collectionName}" из последнего файла сегмента "${lastSegmentName}". Файлы в директории: ${segmentFiles.join(', ')}. Устанавливается индекс 0.`);
                    this.currentSegmentIndex = 0; 
                } else {
                    this.currentSegmentIndex = determinedIndex;
                }
            } else {
                // Коллекция пуста (или все сегменты были невалидны и удалены при восстановлении).
                // Создаем начальный сегмент _0.json.
                await this._writeSegmentDataInternal(0, [], true); 
                this.currentSegmentIndex = 0; 
            }
            this.isInitialized = true;
        } catch (error) {
            console.error(`WiseJSON CRITICAL (_initializeAndRecover): Ошибка для "${this.collectionName}": ${error.message}`, error.stack);
            throw error; 
        }
    }

    async _recoverSegments() {
        let filesInDir;
        try {
            filesInDir = await fs.readdir(this.collectionDirectoryPath);
        } catch (e) {
            if (e.code === 'ENOENT') return; 
            console.error(`WiseJSON RECOVERY: Ошибка чтения директории "${this.collectionDirectoryPath}" при восстановлении: ${e.message}`);
            throw e;
        }

        const segmentBases = new Set();
        filesInDir.forEach(f => {
            const match = f.match(new RegExp(`^(${this.collectionName}_\\d+)(\\.json)?(\\..*)?$`));
            if (match) segmentBases.add(match[1]);
        });

        for (const baseName of segmentBases) {
            const mainP = path.join(this.collectionDirectoryPath, `${baseName}.json`);
            const bakP = path.join(this.collectionDirectoryPath, `${baseName}.json.bak`);
            const newP = path.join(this.collectionDirectoryPath, `${baseName}.json.new`);
            const tmpFiles = filesInDir
                .filter(f => f.startsWith(`${baseName}.json.tmp.`))
                .map(f => path.join(this.collectionDirectoryPath, f));
            
            try {
                const mainIsValid = await this._isValidJsonFile(mainP);
                const bakIsValid = await this._isValidJsonFile(bakP);
                const newIsValid = await this._isValidJsonFile(newP);

                if (mainIsValid) {
                    if (await this._pathExists(bakP)) await fs.unlink(bakP);
                    if (await this._pathExists(newP)) await fs.unlink(newP);
                    for (const tmpP of tmpFiles) if (await this._pathExists(tmpP)) await fs.unlink(tmpP);
                    continue; 
                }

                if (bakIsValid) {
                    console.warn(`WiseJSON RECOVERY: Восстановление "${mainP}" из "${bakP}" для сегмента "${baseName}".`);
                    if (await this._pathExists(mainP)) await fs.unlink(mainP); 
                    await fs.rename(bakP, mainP);
                    if (await this._pathExists(newP)) await fs.unlink(newP);
                    for (const tmpP of tmpFiles) if (await this._pathExists(tmpP)) await fs.unlink(tmpP);
                    continue;
                }

                if (newIsValid) {
                    console.warn(`WiseJSON RECOVERY: Использование временного файла "${newP}" как основного "${mainP}" для сегмента "${baseName}".`);
                    if (await this._pathExists(mainP)) await fs.unlink(mainP);
                    if (await this._pathExists(bakP)) await fs.unlink(bakP);  
                    await fs.rename(newP, mainP);
                    for (const tmpP of tmpFiles) if (await this._pathExists(tmpP)) await fs.unlink(tmpP);
                    continue;
                }
                
                console.warn(`WiseJSON RECOVERY: Для сегмента "${baseName}" не найдено валидных файлов для восстановления. Удаление всех остатков (.json, .bak, .new, .tmp).`);
                if (await this._pathExists(mainP)) await fs.unlink(mainP);
                if (await this._pathExists(bakP)) await fs.unlink(bakP);
                if (await this._pathExists(newP)) await fs.unlink(newP);
                for (const tmpP of tmpFiles) if (await this._pathExists(tmpP)) await fs.unlink(tmpP);

            } catch (error) {
                console.error(`WiseJSON RECOVERY ERROR: Ошибка при обработке файлов для сегмента "${baseName}": ${error.message}`, error.stack);
            }
        }
    }

    async _ensureInitialized() {
        if (!this.isInitialized) {
            await this.initPromise;
        }
    }

    _getSegmentPath(index) {
        return path.join(this.collectionDirectoryPath, `${this.collectionName}_${index}.json`);
    }

    _getSegmentIndexFromName(fileNameWithExt) {
        const justName = path.basename(fileNameWithExt, '.json');
        const match = justName.match(new RegExp(`^${this.collectionName}_(\\d+)$`));
        return match ? parseInt(match[1], 10) : -1;
    }

    async _getActualSegmentFiles() { 
        try {
            const files = await fs.readdir(this.collectionDirectoryPath);
            return files
                .filter(file => file.startsWith(`${this.collectionName}_`) && file.endsWith('.json'))
                .sort((a, b) => {
                    const indexA = this._getSegmentIndexFromName(a);
                    const indexB = this._getSegmentIndexFromName(b);
                    return indexA - indexB;
                });
        } catch (error) {
            if (error.code === 'ENOENT') return []; 
            console.error(`WiseJSON ERROR (_getActualSegmentFiles): Ошибка чтения директории "${this.collectionDirectoryPath}": ${error.message}`);
            throw error;
        }
    }

    async _readSegmentData(index) {
        const segmentPath = this._getSegmentPath(index);
        try {
            const fileContent = await fs.readFile(segmentPath, 'utf-8');
            return JSON.parse(fileContent);
        } catch (error) {
            if (error.code === 'ENOENT') return []; 
            const userFriendlyMessage = `WiseJSON: Сегмент "${segmentPath}" поврежден или нечитаем. (Исходная ошибка: ${error.message})`;
            if (!(error.message.includes("поврежден или нечитаем"))) {
                 console.error(userFriendlyMessage, error.stack);
            }
            throw new Error(userFriendlyMessage);
        }
    }
    
    async _writeSegmentDataInternal(index, data, isBrandNewSegmentFile = false) {
        const segmentPath = this._getSegmentPath(index);      
        const newPath = `${segmentPath}.new`;      
        const bakPath = `${segmentPath}.bak`;      
        
        let backupAttemptedAndMainExisted = false; 
                                            
        try {
            const mainOriginallyExisted = await this._pathExists(segmentPath);

            const jsonData = JSON.stringify(data, null, this.options.jsonIndent);
            await fs.writeFile(newPath, jsonData, 'utf-8');

            if (!isBrandNewSegmentFile && mainOriginallyExisted) {
                backupAttemptedAndMainExisted = true;
                try {
                    if (await this._pathExists(bakPath)) await fs.unlink(bakPath);
                    await fs.rename(segmentPath, bakPath);
                } catch (bakError) {
                    console.error(`WiseJSON WRITE ERROR: Ошибка создания .bak для "${segmentPath}": ${bakError.message}. Откат: удаление ${newPath}.`);
                    try { await fs.unlink(newPath); } catch {} 
                    throw bakError;
                }
            }

            try {
                await fs.rename(newPath, segmentPath);
            } catch (finalRenameError) {
                console.error(`WiseJSON WRITE ERROR: Ошибка переименования .new в "${segmentPath}": ${finalRenameError.message}. Попытка отката.`);
                if (backupAttemptedAndMainExisted && await this._pathExists(bakPath)) { 
                    try {
                        if(await this._pathExists(segmentPath) && !(await this._isValidJsonFile(segmentPath))) {
                             try { await fs.unlink(segmentPath); } catch (e) { if (e.code !== 'ENOENT') console.error(`WiseJSON WRITE WARN: Не удалось удалить ${segmentPath} перед восстановлением .bak`, e.message); }
                        } else if (await this._pathExists(segmentPath)) {
                            // Do nothing, main file might be ok
                        }
                        await fs.rename(bakPath, segmentPath); 
                        console.warn(`WiseJSON WRITE: Успешно восстановлен .bak для "${segmentPath}".`);
                    } catch (restoreError) {
                        console.error(`WiseJSON WRITE CRITICAL: Ошибка восстановления .bak для "${segmentPath}": ${restoreError.message}.`);
                    }
                }
                try { await fs.unlink(newPath); } catch (e){ if(e.code !== 'ENOENT') console.error(`WiseJSON WRITE ERROR: Не удалось удалить ${newPath} при откате финального rename: ${e.message}`);}
                throw finalRenameError;
            }

            if (backupAttemptedAndMainExisted && await this._pathExists(bakPath)) {
                try { await fs.unlink(bakPath); } catch (e) { if (e.code !== 'ENOENT') console.warn(`WiseJSON WRITE WARN: Не удалось удалить ${bakPath} после успешной записи: ${e.message}`); }
            }
            return Buffer.byteLength(jsonData, 'utf8');
        } catch (error) {
            if (await this._pathExists(newPath) && (error.path !== newPath || (error.syscall && error.syscall !== 'unlink'))) {
                 try { await fs.unlink(newPath); } catch {}
            }
            throw error; 
        }
    }
    
    _enqueueWriteOperation(operationFn) {
        const operationPromise = this.writeQueue
            .catch(prevErrInQueue => {
                console.warn(`WiseJSON Info: Предыдущая операция в очереди для "${this.collectionName}" завершилась с ошибкой: ${prevErrInQueue.message}. Запускаем следующую...`);
                return Promise.resolve(); 
            })
            .then(() => this._ensureInitialized())
            .then(() => operationFn())
            .catch(currentOperationError => {
                return Promise.reject(currentOperationError);
            });
        this.writeQueue = operationPromise;
        return operationPromise;
    }

    _emit(eventName, ...args) {
        const listeners = this._listeners[eventName];
        if (listeners && listeners.length > 0) {
            listeners.forEach(listener => {
                try {
                    Promise.resolve(listener(...args)).catch(listenerError => {
                        console.error(`WiseJSON Event Listener Error: Ошибка в слушателе события '${eventName}' для коллекции '${this.collectionName}': ${listenerError.message}`, listenerError.stack);
                    });
                } catch (syncError) { 
                    console.error(`WiseJSON Event Listener Error: Синхронная ошибка при вызове слушателя события '${eventName}' для коллекции '${this.collectionName}': ${syncError.message}`, syncError.stack);
                }
            });
        }
    }

    on(eventName, listener) {
        if (typeof listener !== 'function') {
            throw new Error('WiseJSON: Слушатель должен быть функцией.');
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

    async _rawInsert(itemDataToInsert) {
        const newItem = {
            _id: itemDataToInsert._id || this.options.idGenerator(),
            ...itemDataToInsert,
            createdAt: itemDataToInsert.createdAt || new Date().toISOString(),
            updatedAt: itemDataToInsert.updatedAt || new Date().toISOString(),
        };
        newItem._id = newItem._id; 
        newItem.createdAt = newItem.createdAt;
        newItem.updatedAt = newItem.updatedAt;

        let currentSegmentData = await this._readSegmentData(this.currentSegmentIndex);
        const isCurrentSegmentEmpty = currentSegmentData.length === 0;

        const potentialNewData = [...currentSegmentData, newItem];
        const jsonDataSize = Buffer.byteLength(JSON.stringify(potentialNewData, null, this.options.jsonIndent), 'utf8');

        if (jsonDataSize > this.options.maxSegmentSizeBytes && currentSegmentData.length > 0) {
            this.currentSegmentIndex++;
            await this._writeSegmentDataInternal(this.currentSegmentIndex, [newItem], true); 
        } else {
            currentSegmentData.push(newItem);
            const isFirstWriteToFile = this.currentSegmentIndex === 0 && isCurrentSegmentEmpty;
            await this._writeSegmentDataInternal(this.currentSegmentIndex, currentSegmentData, isFirstWriteToFile);
        }
        this._emit('afterInsert', { ...newItem });
        return newItem;
    }

    async _rawUpdate(id, updatesToApply) {
        let originalDocumentSnapshot = null; 
        const segmentFiles = await this._getActualSegmentFiles();

        for (const segmentFileName of segmentFiles) {
            const segmentIndex = this._getSegmentIndexFromName(segmentFileName);
            if (segmentIndex === -1) continue;

            let segmentData = await this._readSegmentData(segmentIndex);
            const itemIndex = segmentData.findIndex(item => item._id === id);

            if (itemIndex !== -1) {
                originalDocumentSnapshot = { ...segmentData[itemIndex] }; 
                const updatedItem = {
                    ...segmentData[itemIndex],
                    ...updatesToApply, 
                    updatedAt: new Date().toISOString(),
                };
                segmentData[itemIndex] = updatedItem;
                await this._writeSegmentDataInternal(segmentIndex, segmentData, false);
                this._emit('afterUpdate', { ...updatedItem }, originalDocumentSnapshot);
                return updatedItem;
            }
        }
        return null;
    }

    /**
     * Вставляет новый документ в коллекцию.
     * Поля `_id`, `createdAt`, `updatedAt` будут автоматически сгенерированы/перезаписаны.
     * @param {object} itemData - Данные для нового документа.
     * @returns {Promise<object>} - Вставленный документ.
     */
    async insert(itemData) {
        const cleanItemData = { ...itemData };
        delete cleanItemData._id; 
        delete cleanItemData.createdAt;
        delete cleanItemData.updatedAt;
        return this._enqueueWriteOperation(() => this._rawInsert(cleanItemData));
    }

    /**
     * Получает все документы из коллекции.
     * @returns {Promise<object[]>} - Массив всех документов.
     */
    async getAll() {
        await this._ensureInitialized();
        const allItems = [];
        const segmentFiles = await this._getActualSegmentFiles();
        for (const segmentFileName of segmentFiles) {
            const index = this._getSegmentIndexFromName(segmentFileName);
            if (index === -1) continue;
            const segmentData = await this._readSegmentData(index);
            allItems.push(...segmentData);
        }
        return allItems;
    }

    /**
     * Находит все документы, удовлетворяющие функции-запросу.
     * @param {function(object):boolean} queryFunction - Функция, принимающая документ и возвращающая true, если он соответствует условию.
     * @returns {Promise<object[]>} - Массив найденных документов.
     */
    async find(queryFunction) {
        if (typeof queryFunction !== 'function') {
            throw new Error("WiseJSON: queryFunction для find должен быть функцией.");
        }
        const allItems = await this.getAll();
        return allItems.filter(queryFunction);
    }

    /**
     * Находит первый документ, удовлетворяющий функции-запросу.
     * @param {function(object):boolean} queryFunction - Функция, принимающая документ и возвращающая true, если он соответствует условию.
     * @returns {Promise<object|null>} - Найденный документ или null.
     */
    async findOne(queryFunction) {
        if (typeof queryFunction !== 'function') {
            throw new Error("WiseJSON: queryFunction для findOne должен быть функцией.");
        }
        await this._ensureInitialized();
        const segmentFiles = await this._getActualSegmentFiles();
        for (const segmentFileName of segmentFiles) {
            const index = this._getSegmentIndexFromName(segmentFileName);
            if (index === -1) continue;

            const segmentData = await this._readSegmentData(index);
            const foundItem = segmentData.find(queryFunction);
            if (foundItem) {
                return foundItem;
            }
        }
        return null;
    }

    /**
     * Находит документ по его уникальному идентификатору `_id`.
     * @param {string} id - Уникальный идентификатор документа.
     * @returns {Promise<object|null>} - Найденный документ или null.
     */
    async getById(id) {
        if (!id || typeof id !== 'string') {
            throw new Error("WiseJSON: ID для getById должен быть непустой строкой.");
        }
        return this.findOne(item => item._id === id);
    }

    /**
     * Обновляет документ с указанным `_id`.
     * Поля `_id` и `createdAt` не изменяются. `updatedAt` обновляется автоматически.
     * @param {string} id - `_id` документа для обновления.
     * @param {object} updates - Объект с полями для обновления.
     * @returns {Promise<object|null>} - Обновленный документ или null, если документ не найден.
     */
    async update(id, updates) {
        const cleanUpdates = { ...updates };
        if (cleanUpdates._id && cleanUpdates._id !== id) {
            console.warn(`WiseJSON: Попытка изменить _id на '${cleanUpdates._id}' для документа с ID '${id}' при обновлении. Поле _id в объекте updates будет проигнорировано.`);
        }
        delete cleanUpdates._id; 
        delete cleanUpdates.createdAt; 
        return this._enqueueWriteOperation(() => this._rawUpdate(id, cleanUpdates));
    }

    /**
     * Удаляет документ с указанным `_id`.
     * @param {string} id - `_id` документа для удаления.
     * @returns {Promise<boolean>} - `true`, если документ был удален, иначе `false`.
     */
    async remove(id) {
        return this._enqueueWriteOperation(async () => {
            if (!id || typeof id !== 'string') {
                throw new Error("WiseJSON: ID для remove должен быть непустой строкой.");
            }
            let removedDocumentSnapshot = null; 
            const segmentFiles = await this._getActualSegmentFiles();
            for (const segmentFileName of segmentFiles) {
                const segmentIndex = this._getSegmentIndexFromName(segmentFileName);
                 if (segmentIndex === -1) continue;

                let segmentData = await this._readSegmentData(segmentIndex);
                
                const itemToRemoveIndex = segmentData.findIndex(item => item._id === id);
                if (itemToRemoveIndex !== -1) {
                    removedDocumentSnapshot = { ...segmentData[itemToRemoveIndex] }; 
                }

                const newData = segmentData.filter(item => item._id !== id);

                if (newData.length < segmentData.length) { 
                    await this._writeSegmentDataInternal(segmentIndex, newData, false); 
                    if (removedDocumentSnapshot) { 
                        this._emit('afterRemove', id, removedDocumentSnapshot);
                    }
                    return true;
                }
            }
            return false;
        });
    }

    /**
     * Подсчитывает количество документов в коллекции.
     * @param {function(object):boolean} [queryFunction] - Необязательная функция-фильтр. Если предоставлена, подсчитываются только соответствующие документы.
     * @returns {Promise<number>} - Количество документов.
     */
    async count(queryFunction) {
        await this._ensureInitialized();
        let documentCount = 0;
        const segmentFiles = await this._getActualSegmentFiles();
        for (const segmentFileName of segmentFiles) {
            const index = this._getSegmentIndexFromName(segmentFileName);
            if (index === -1) continue;

            const segmentData = await this._readSegmentData(index);
            if (queryFunction && typeof queryFunction === 'function') {
                for (const document of segmentData) {
                    if (queryFunction(document)) {
                        documentCount++;
                    }
                }
            } else {
                documentCount += segmentData.length;
            }
        }
        return documentCount;
    }

    /**
     * Обновляет документ, если он найден по `query`, иначе вставляет новый документ.
     * @param {object|function(object):boolean} query - Объект для точного поиска или функция-предикат.
     * @param {object} dataToUpsert - Данные для вставки или обновления.
     * @param {object} [options] - Дополнительные опции.
     * @param {object} [options.setOnInsert] - Данные, применяемые только при вставке нового документа.
     * @returns {Promise<{document: object, operation: 'inserted' | 'updated'}>} - Результат операции.
     */
    async upsert(query, dataToUpsert, options = {}) {
        return this._enqueueWriteOperation(async () => {
            if (!query || (typeof query !== 'object' && typeof query !== 'function')) {
                throw new Error("WiseJSON: query для upsert должен быть объектом или функцией.");
            }
            if (!dataToUpsert || typeof dataToUpsert !== 'object') {
                throw new Error("WiseJSON: dataToUpsert для upsert должен быть объектом.");
            }

            const queryFn = typeof query === 'function' ? query : (doc =>
                Object.keys(query).every(key => doc[key] === query[key])
            );
            const existingDocument = await this.findOne(queryFn);

            if (existingDocument) {
                const updatesForRaw = { ...dataToUpsert };
                delete updatesForRaw._id; 
                delete updatesForRaw.createdAt;
                const updatedDocument = await this._rawUpdate(existingDocument._id, updatesForRaw);
                return { document: updatedDocument, operation: 'updated' };
            } else {
                let documentToInsert = {};
                if (typeof query === 'object' && query !== null && Object.keys(query).length > 0) { // Убедимся, что query - это непустой объект, если он не функция
                    documentToInsert = { ...query };
                }
                documentToInsert = { ...documentToInsert, ...dataToUpsert };
                if (options.setOnInsert && typeof options.setOnInsert === 'object') {
                    documentToInsert = { ...options.setOnInsert, ...documentToInsert }; // setOnInsert может перезаписать поля из dataToUpsert/query, если они совпадают, или наоборот. Логично, если setOnInsert имеет приоритет для новых полей. Или { ...documentToInsert, ...options.setOnInsert }
                }
                // Обеспечим, что setOnInsert не перезапишет _id, если он был в query
                const finalId = documentToInsert._id || (query && typeof query === 'object' ? query._id : undefined);

                delete documentToInsert.createdAt; 
                delete documentToInsert.updatedAt;
                // Если _id пришел из query, он уже в documentToInsert. Если нет, _rawInsert сгенерирует.
                // Если _id был в dataToUpsert, он также будет там.
                // Если _id был в setOnInsert, он будет там. _rawInsert все равно сгенерирует свой, если не найдет.
                // Чтобы гарантировать, что ID из query (если это объект-запрос с _id) используется, или из dataToUpsert (если есть)
                // или из setOnInsert (если есть и это не функция-запрос) - нужно аккуратно смержить.
                // Текущая логика _rawInsert: itemDataToInsert._id || this.options.idGenerator().
                // Если в documentToInsert есть _id, он будет использован.

                if (finalId) documentToInsert._id = finalId;


                const insertedDocument = await this._rawInsert(documentToInsert); 
                return { document: insertedDocument, operation: 'inserted' };
            }
        });
    }

    /**
     * Получает статистику по коллекции.
     * @returns {Promise<{documentCount: number, segmentCount: number, totalDiskSizeBytes: number, options: object}>} Статистика коллекции.
     */
    async getCollectionStats() {
        await this._ensureInitialized();

        const segmentFiles = await this._getActualSegmentFiles();
        const segmentCount = segmentFiles.length;
        let totalDiskSizeBytes = 0;
        let documentCount = 0; // Используем this.count() для точности с возможным queryFunction в будущем, но здесь нужен общий подсчет

        for (const segmentFileName of segmentFiles) {
            const segmentPath = path.join(this.collectionDirectoryPath, segmentFileName);
            try {
                const stats = await fs.stat(segmentPath);
                totalDiskSizeBytes += stats.size;
            } catch (error) {
                console.warn(`WiseJSON WARN (getCollectionStats): Не удалось получить размер для сегмента "${segmentPath}": ${error.message}`);
            }
        }
        
        // Для documentCount, мы можем либо пересчитать, либо вызвать this.count()
        // Вызов this.count() проще и использует уже существующую логику.
        documentCount = await this.count(); 

        return {
            documentCount,
            segmentCount,
            totalDiskSizeBytes,
            options: { ...this.options } // Возвращаем копию опций
        };
    }
}

module.exports = Collection;