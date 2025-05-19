// wise-json/collection.js
const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_MAX_SEGMENT_SIZE_BYTES = 1 * 1024 * 1024; // 1MB
const DEFAULT_JSON_INDENT = 2; // 2 пробела для форматирования, null для компактного JSON

/**
 * Класс для управления коллекцией документов, хранящихся в JSON-сегментах.
 * Обеспечивает надежную запись, автоматическую сегментацию и асинхронный API.
 */
class Collection {
    /**
     * Создает экземпляр Collection.
     * @param {string} collectionName - Имя коллекции.
     * @param {string} dbDirectoryPath - Путь к корневой директории базы данных.
     * @param {object} [options={}] - Опции для коллекции.
     * @param {number} [options.maxSegmentSizeBytes=1048576] - Максимальный размер файла-сегмента в байтах.
     * @param {number|null} [options.jsonIndent=2] - Отступ для форматирования JSON или null/0 для компактного вывода.
     * @param {function():string} [options.idGenerator] - Функция для генерации ID документов (по умолчанию uuidv4).
     */
    constructor(collectionName, dbDirectoryPath, options = {}) {
        this.collectionName = collectionName;
        this.collectionDirectoryPath = path.join(dbDirectoryPath, collectionName);
        this.options = {
            maxSegmentSizeBytes: options.maxSegmentSizeBytes || DEFAULT_MAX_SEGMENT_SIZE_BYTES,
            jsonIndent: options.jsonIndent !== undefined ? options.jsonIndent : DEFAULT_JSON_INDENT,
            idGenerator: options.idGenerator || (() => uuidv4())
        };

        /** @private Текущий индекс активного сегмента для записи. */
        this.currentSegmentIndex = 0;
        /** @private Промис, используемый для организации очереди операций записи. */
        this.writeQueue = Promise.resolve();
        /** @private Флаг, указывающий, завершена ли инициализация коллекции. */
        this.isInitialized = false;
        /** @private Промис, представляющий процесс инициализации и восстановления коллекции. */
        this.initPromise = this._initializeAndRecover();
        /** @private Объект для хранения слушателей событий. */
        this._listeners = {};
    }

    /**
     * Проверяет существование пути в файловой системе.
     * @private
     * @param {string} filePath - Путь к файлу или директории.
     * @returns {Promise<boolean>} true, если путь существует, иначе false.
     */
    async _pathExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Проверяет, является ли файл валидным JSON-файлом.
     * @private
     * @param {string} filePath - Путь к файлу.
     * @returns {Promise<boolean>} true, если файл существует и содержит валидный JSON, иначе false.
     */
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
    
    /**
     * Инициализирует директорию коллекции, восстанавливает сегменты при необходимости
     * и определяет текущий активный сегмент.
     * @private
     * @returns {Promise<void>}
     */
    async _initializeAndRecover() {
        try {
            await fs.mkdir(this.collectionDirectoryPath, { recursive: true });
            await this._recoverSegments(); 
            
            const segmentFiles = await this._getActualSegmentFiles();

            if (segmentFiles.length > 0) {
                const lastSegmentName = segmentFiles[segmentFiles.length - 1];
                const determinedIndex = this._getSegmentIndexFromName(lastSegmentName);

                if (determinedIndex === -1) {
                    console.warn(`WiseJSON WARN (_initializeAndRecover): Не удалось определить currentSegmentIndex для коллекции "${this.collectionName}" из последнего файла сегмента "${lastSegmentName}". Файлы в директории: ${segmentFiles.join(', ')}. Устанавливается индекс 0.`);
                    this.currentSegmentIndex = 0; 
                } else {
                    this.currentSegmentIndex = determinedIndex;
                }
            } else {
                await this._writeSegmentDataInternal(0, [], true); 
                this.currentSegmentIndex = 0; 
            }
            this.isInitialized = true;
        } catch (error) {
            console.error(`WiseJSON CRITICAL (_initializeAndRecover): Ошибка для "${this.collectionName}": ${error.message}`, error.stack);
            throw error; 
        }
    }

    /**
     * Выполняет процедуру восстановления для каждого базового имени сегмента,
     * проверяя .json, .bak, и .new файлы.
     * @private
     * @returns {Promise<void>}
     */
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

    /**
     * Гарантирует, что коллекция была инициализирована перед выполнением операций.
     * @private
     * @returns {Promise<void>}
     */
    async _ensureInitialized() {
        if (!this.isInitialized) {
            await this.initPromise;
        }
    }

    /**
     * Возвращает полный путь к файлу сегмента по его индексу.
     * @private
     * @param {number} index - Индекс сегмента.
     * @returns {string} Полный путь к файлу сегмента.
     */
    _getSegmentPath(index) {
        return path.join(this.collectionDirectoryPath, `${this.collectionName}_${index}.json`);
    }

    /**
     * Извлекает индекс сегмента из имени файла.
     * @private
     * @param {string} fileNameWithExt - Имя файла с расширением (например, "mycollection_0.json").
     * @returns {number} Индекс сегмента или -1, если имя файла не соответствует шаблону.
     */
    _getSegmentIndexFromName(fileNameWithExt) {
        const justName = path.basename(fileNameWithExt, '.json');
        const match = justName.match(new RegExp(`^${this.collectionName}_(\\d+)$`));
        return match ? parseInt(match[1], 10) : -1;
    }

    /**
     * Получает отсортированный список имен файлов актуальных сегментов (.json) в директории коллекции.
     * @private
     * @returns {Promise<string[]>} Массив имен файлов сегментов, отсортированных по индексу.
     */
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

    /**
     * Читает и парсит данные из файла сегмента.
     * @private
     * @param {number} index - Индекс сегмента.
     * @returns {Promise<Array<object>>} Массив документов из сегмента. Возвращает пустой массив, если сегмент не найден.
     * @throws {Error} Если файл сегмента поврежден или нечитаем.
     */
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
    
    /**
     * Записывает данные в файл сегмента, используя стратегию .new -> .bak -> rename для надежности.
     * @private
     * @param {number} index - Индекс сегмента.
     * @param {Array<object>} data - Массив документов для записи.
     * @param {boolean} [isBrandNewSegmentFile=false] - Флаг, указывающий, создается ли этот файл сегмента впервые (не требует .bak).
     * @returns {Promise<number>} Размер записанных данных в байтах.
     * @throws {Error} Если произошла ошибка при записи или операциях с файлами.
     */
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
    
    /**
     * Добавляет асинхронную операцию записи в очередь для последовательного выполнения.
     * @private
     * @param {function():Promise<any>} operationFn - Функция, выполняющая операцию записи и возвращающая промис.
     * @returns {Promise<any>} Промис, который разрешается результатом выполнения operationFn.
     */
    _enqueueWriteOperation(operationFn) {
        const operationPromise = this.writeQueue
            .catch(prevErrInQueue => {
                console.warn(`WiseJSON Info: Предыдущая операция в очереди для "${this.collectionName}" завершилась с ошибкой: ${prevErrInQueue.message}. Запускаем следующую...`);
                return Promise.resolve(); 
            })
            .then(() => this._ensureInitialized()) // Убедимся в инициализации перед каждой операцией из очереди
            .then(() => operationFn())
            .catch(currentOperationError => {
                // Ошибка текущей операции будет возвращена вызывающему коду
                return Promise.reject(currentOperationError);
            });
        this.writeQueue = operationPromise; // Цепочка промисов
        return operationPromise;
    }

    /**
     * Эмитирует событие для всех подписанных слушателей.
     * Слушатели выполняются асинхронно и их ошибки логируются, не прерывая основной поток.
     * @private
     * @param {string} eventName - Имя события.
     * @param  {...any} args - Аргументы для передачи слушателям.
     */
    _emit(eventName, ...args) {
        const listeners = this._listeners[eventName];
        if (listeners && listeners.length > 0) {
            listeners.forEach(listener => {
                try {
                    // Оборачиваем вызов слушателя в Promise.resolve для обработки как синхронных, так и асинхронных слушателей
                    Promise.resolve(listener(...args)).catch(listenerError => {
                        console.error(`WiseJSON Event Listener Error: Ошибка в слушателе события '${eventName}' для коллекции '${this.collectionName}': ${listenerError.message}`, listenerError.stack);
                    });
                } catch (syncError) { 
                    // Ловим синхронные ошибки непосредственно при вызове listener(...args)
                    console.error(`WiseJSON Event Listener Error: Синхронная ошибка при вызове слушателя события '${eventName}' для коллекции '${this.collectionName}': ${syncError.message}`, syncError.stack);
                }
            });
        }
    }

    /**
     * Подписывает функцию-слушатель на событие коллекции.
     * @param {'afterInsert'|'afterUpdate'|'afterRemove'} eventName - Имя события.
     * @param {function(...any):void|Promise<void>} listener - Функция-слушатель.
     * @throws {Error} Если слушатель не является функцией.
     */
    on(eventName, listener) {
        if (typeof listener !== 'function') {
            throw new Error('WiseJSON: Слушатель должен быть функцией.');
        }
        if (!this._listeners[eventName]) {
            this._listeners[eventName] = [];
        }
        this._listeners[eventName].push(listener);
    }

    /**
     * Отписывает функцию-слушатель от события коллекции.
     * Если слушатель не указан, отписывает всех слушателей для данного события.
     * @param {'afterInsert'|'afterUpdate'|'afterRemove'} eventName - Имя события.
     * @param {function} [listener] - Функция-слушатель для удаления.
     */
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

    /**
     * Внутренний метод для вставки нового документа без постановки в очередь.
     * Вызывается из _enqueueWriteOperation.
     * @private
     * @param {object} itemDataToInsert - Данные для нового документа (уже очищенные от пользовательских _id, createdAt, updatedAt).
     * @returns {Promise<object>} Вставленный документ с системными полями.
     */
    async _rawInsert(itemDataToInsert) {
        const newItem = {
            _id: itemDataToInsert._id || this.options.idGenerator(), // Используем ID из данных, если он предоставлен (например, при upsert)
            ...itemDataToInsert,
            createdAt: itemDataToInsert.createdAt || new Date().toISOString(), // Аналогично для createdAt/updatedAt
            updatedAt: itemDataToInsert.updatedAt || new Date().toISOString(),
        };
        // Гарантируем, что системные поля точно установлены, даже если они были null/undefined в itemDataToInsert
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
        this._emit('afterInsert', { ...newItem }); // Эмитируем копию
        return newItem;
    }

    /**
     * Внутренний метод для обновления документа без постановки в очередь.
     * Вызывается из _enqueueWriteOperation.
     * @private
     * @param {string} id - ID документа для обновления.
     * @param {object} updatesToApply - Объект с полями для обновления (уже очищенный от _id, createdAt).
     * @returns {Promise<object|null>} Обновленный документ или null, если не найден.
     */
    async _rawUpdate(id, updatesToApply) {
        let originalDocumentSnapshot = null; 
        const segmentFiles = await this._getActualSegmentFiles();

        for (const segmentFileName of segmentFiles) {
            const segmentIndex = this._getSegmentIndexFromName(segmentFileName);
            if (segmentIndex === -1) continue; // Пропускаем некорректно именованные файлы, если такие попались

            let segmentData = await this._readSegmentData(segmentIndex);
            const itemIndex = segmentData.findIndex(item => item._id === id);

            if (itemIndex !== -1) {
                originalDocumentSnapshot = { ...segmentData[itemIndex] }; // Копия для события
                const updatedItem = {
                    ...segmentData[itemIndex],
                    ...updatesToApply, // Применяем обновления
                    updatedAt: new Date().toISOString(), // Обновляем время изменения
                };
                segmentData[itemIndex] = updatedItem;
                await this._writeSegmentDataInternal(segmentIndex, segmentData, false);
                this._emit('afterUpdate', { ...updatedItem }, originalDocumentSnapshot); // Эмитируем копии
                return updatedItem;
            }
        }
        return null; // Документ не найден ни в одном сегменте
    }

    /**
     * Вставляет новый документ в коллекцию.
     * Поля `_id`, `createdAt`, `updatedAt` будут автоматически сгенерированы/перезаписаны.
     * Операция добавляется в очередь записи.
     * @param {object} itemData - Данные для нового документа.
     * @returns {Promise<object>} - Вставленный документ.
     */
    async insert(itemData) {
        const cleanItemData = { ...itemData };
        // Удаляем системные поля, чтобы они были сгенерированы автоматически и надежно
        delete cleanItemData._id; 
        delete cleanItemData.createdAt;
        delete cleanItemData.updatedAt;
        return this._enqueueWriteOperation(() => this._rawInsert(cleanItemData));
    }

    /**
     * Получает все документы из коллекции.
     * Операция выполняется немедленно, не вставая в очередь записи.
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
     * Операция выполняется немедленно, не вставая в очередь записи.
     * @param {function(object):boolean} queryFunction - Функция, принимающая документ и возвращающая true, если он соответствует условию.
     * @returns {Promise<object[]>} - Массив найденных документов.
     * @throws {Error} Если queryFunction не является функцией.
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
     * Операция выполняется немедленно, не вставая в очередь записи.
     * @param {function(object):boolean} queryFunction - Функция, принимающая документ и возвращающая true, если он соответствует условию.
     * @returns {Promise<object|null>} - Найденный документ или null.
     * @throws {Error} Если queryFunction не является функцией.
     */
    async findOne(queryFunction) {
        if (typeof queryFunction !== 'function') {
            throw new Error("WiseJSON: queryFunction для findOne должен быть функцией.");
        }
        await this._ensureInitialized();
        const segmentFiles = await this._getActualSegmentFiles();
        // Итерация по сегментам в порядке их создания
        for (const segmentFileName of segmentFiles) {
            const index = this._getSegmentIndexFromName(segmentFileName);
            if (index === -1) continue;

            const segmentData = await this._readSegmentData(index);
            const foundItem = segmentData.find(queryFunction);
            if (foundItem) {
                return foundItem; // Возвращаем первый найденный
            }
        }
        return null;
    }

    /**
     * Находит документ по его уникальному идентификатору `_id`.
     * Операция выполняется немедленно, не вставая в очередь записи.
     * @param {string} id - Уникальный идентификатор документа.
     * @returns {Promise<object|null>} - Найденный документ или null.
     * @throws {Error} Если ID не является непустой строкой.
     */
    async getById(id) {
        if (!id || typeof id !== 'string') {
            throw new Error("WiseJSON: ID для getById должен быть непустой строкой.");
        }
        // findOne уже вызывает _ensureInitialized()
        return this.findOne(item => item._id === id);
    }

    /**
     * Обновляет документ с указанным `_id`.
     * Поля `_id` и `createdAt` не изменяются. `updatedAt` обновляется автоматически.
     * Операция добавляется в очередь записи.
     * @param {string} id - `_id` документа для обновления.
     * @param {object} updates - Объект с полями для обновления.
     * @returns {Promise<object|null>} - Обновленный документ или null, если документ не найден.
     */
    async update(id, updates) {
        const cleanUpdates = { ...updates };
        if (cleanUpdates._id && cleanUpdates._id !== id) {
            console.warn(`WiseJSON: Попытка изменить _id на '${cleanUpdates._id}' для документа с ID '${id}' при обновлении. Поле _id в объекте updates будет проигнорировано.`);
        }
        // Запрещаем изменение системных полей через этот метод
        delete cleanUpdates._id; 
        delete cleanUpdates.createdAt; 
        // updatedAt будет обновлен в _rawUpdate
        return this._enqueueWriteOperation(() => this._rawUpdate(id, cleanUpdates));
    }

    /**
     * Удаляет документ с указанным `_id`.
     * Операция добавляется в очередь записи.
     * @param {string} id - `_id` документа для удаления.
     * @returns {Promise<boolean>} - `true`, если документ был удален, иначе `false`.
     * @throws {Error} Если ID не является непустой строкой.
     */
    async remove(id) {
        return this._enqueueWriteOperation(async () => {
            if (!id || typeof id !== 'string') {
                // Эту проверку можно было бы вынести из коллбэка enqueue,
                // но тогда промис из enqueue не будет дожидаться ее, если она бросит ошибку.
                // Оставляем здесь для консистентности обработки ошибок через очередь.
                throw new Error("WiseJSON: ID для remove должен быть непустой строкой.");
            }
            let removedDocumentSnapshot = null; 
            const segmentFiles = await this._getActualSegmentFiles();
            for (const segmentFileName of segmentFiles) {
                const segmentIndex = this._getSegmentIndexFromName(segmentFileName);
                 if (segmentIndex === -1) continue;

                let segmentData = await this._readSegmentData(segmentIndex);
                
                const originalLength = segmentData.length;
                const itemToRemoveIndex = segmentData.findIndex(item => item._id === id);
                
                if (itemToRemoveIndex !== -1) {
                    removedDocumentSnapshot = { ...segmentData[itemToRemoveIndex] }; 
                }

                const newData = segmentData.filter(item => item._id !== id);

                if (newData.length < originalLength) { // Если что-то было удалено
                    await this._writeSegmentDataInternal(segmentIndex, newData, newData.length === 0 && segmentFiles.length === 1 && segmentIndex === 0); 
                    if (removedDocumentSnapshot) { 
                        this._emit('afterRemove', id, removedDocumentSnapshot);
                    }
                    return true; // Документ удален
                }
            }
            return false; // Документ не найден
        });
    }

    /**
     * Подсчитывает количество документов в коллекции.
     * Может принимать функцию-фильтр для подсчета только соответствующих документов.
     * Операция выполняется немедленно, не вставая в очередь записи.
     * @param {function(object):boolean} [queryFunction] - Необязательная функция-фильтр.
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
     * Операция добавляется в очередь записи.
     * @param {object|function(object):boolean} query - Объект для точного поиска по полям или функция-предикат.
     * @param {object} dataToUpsert - Данные для вставки или обновления. Системные поля (`_id`, `createdAt`, `updatedAt`) из этого объекта будут проигнорированы или перезаписаны.
     * @param {object} [options] - Дополнительные опции.
     * @param {object} [options.setOnInsert] - Данные, которые будут применены к документу только в случае его вставки (если документ не найден по `query`). Эти поля могут перезаписать поля из `dataToUpsert` или `query` при вставке.
     * @returns {Promise<{document: object, operation: 'inserted' | 'updated'}>} - Результат операции: вставленный/обновленный документ и тип операции.
     * @throws {Error} Если `query` или `dataToUpsert` имеют некорректный тип.
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
            
            // findOne здесь вызовет _ensureInitialized, так что мы готовы к чтению.
            const existingDocument = await this.findOne(queryFn);

            if (existingDocument) {
                // Обновление существующего документа
                const updatesForRaw = { ...dataToUpsert };
                delete updatesForRaw._id; 
                delete updatesForRaw.createdAt;
                // updatedAt будет установлен в _rawUpdate
                const updatedDocument = await this._rawUpdate(existingDocument._id, updatesForRaw);
                return { document: updatedDocument, operation: 'updated' };
            } else {
                // Вставка нового документа
                let documentToInsert = {};
                // Если query - это объект, его поля могут быть использованы как основа для нового документа
                if (typeof query === 'object' && query !== null && !Array.isArray(query)) { // Убедимся, что query - это не массив и не null
                    documentToInsert = { ...query };
                }
                
                // Данные из dataToUpsert перезаписывают или добавляют поля
                documentToInsert = { ...documentToInsert, ...dataToUpsert };
                
                // Данные из setOnInsert применяются последними и могут перезаписать предыдущие
                if (options.setOnInsert && typeof options.setOnInsert === 'object') {
                    documentToInsert = { ...documentToInsert, ...options.setOnInsert };
                }

                // _rawInsert сам позаботится о _id, createdAt, updatedAt, если они не предоставлены в documentToInsert явно.
                // Если _id, createdAt, updatedAt были в query, dataToUpsert или setOnInsert, они будут учтены _rawInsert.
                // Если _id отсутствует, _rawInsert сгенерирует новый.
                // Если createdAt/updatedAt отсутствуют, _rawInsert сгенерирует их.
                const insertedDocument = await this._rawInsert(documentToInsert); 
                return { document: insertedDocument, operation: 'inserted' };
            }
        });
    }

    /**
     * Получает статистику по коллекции: количество документов, сегментов,
     * общий размер на диске и текущие опции конфигурации.
     * Операция выполняется немедленно, не вставая в очередь записи.
     * @returns {Promise<{documentCount: number, segmentCount: number, totalDiskSizeBytes: number, options: object}>} Статистика коллекции.
     */
    async getCollectionStats() {
        await this._ensureInitialized();

        const segmentFiles = await this._getActualSegmentFiles();
        const segmentCount = segmentFiles.length;
        let totalDiskSizeBytes = 0;
        
        for (const segmentFileName of segmentFiles) {
            const segmentPath = path.join(this.collectionDirectoryPath, segmentFileName);
            try {
                const stats = await fs.stat(segmentPath);
                totalDiskSizeBytes += stats.size;
            } catch (error) {
                // Логируем, но не прерываем сбор остальной статистики
                console.warn(`WiseJSON WARN (getCollectionStats): Не удалось получить размер для сегмента "${segmentPath}": ${error.message}`);
            }
        }
        
        // Получаем количество документов через существующий метод count
        const documentCount = await this.count(); 

        return {
            documentCount,
            segmentCount,
            totalDiskSizeBytes,
            options: { ...this.options } // Возвращаем копию опций, чтобы избежать их случайного изменения извне
        };
    }
}

module.exports = Collection;