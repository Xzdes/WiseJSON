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
                    console.warn(`WiseJSON Collection ('${this.collectionName}') WARN (_initializeAndRecover): Не удалось определить currentSegmentIndex из последнего файла сегмента "${lastSegmentName}". Файлы в директории: ${segmentFiles.join(', ')}. Устанавливается индекс 0.`);
                    this.currentSegmentIndex = 0; 
                } else {
                    this.currentSegmentIndex = determinedIndex;
                }
            } else {
                // Если нет валидных сегментов после восстановления, создаем начальный пустой сегмент _0.json
                await this._writeSegmentDataInternal(0, [], true); 
                this.currentSegmentIndex = 0; 
            }
            this.isInitialized = true;
        } catch (error) {
            // Ошибки здесь уже логируются в _recoverSegments или _writeSegmentDataInternal, если они оттуда
            // Добавляем более общий контекст, если ошибка не из них
            const baseMessage = `WiseJSON Collection ('${this.collectionName}') CRITICAL (_initializeAndRecover): Ошибка инициализации`;
            if (!error.message.startsWith('WiseJSON')) { // Проверяем, чтобы не дублировать префикс
                 console.error(`${baseMessage}: ${error.message}`, error.stack);
            }
            throw error; // Перебрасываем оригинальную или новую ошибку с контекстом
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
            if (e.code === 'ENOENT') return; // Директории нет, нечего восстанавливать
            console.error(`WiseJSON Collection ('${this.collectionName}') RECOVERY: Ошибка чтения директории "${this.collectionDirectoryPath}" при восстановлении: ${e.message}`);
            throw e; // Перебрасываем, чтобы _initializeAndRecover обработал
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
                    // Основной файл в порядке, удаляем временные и бэкап
                    if (await this._pathExists(bakP)) await fs.unlink(bakP);
                    if (await this._pathExists(newP)) await fs.unlink(newP);
                    for (const tmpP of tmpFiles) if (await this._pathExists(tmpP)) await fs.unlink(tmpP);
                    continue; 
                }

                // Основной файл невалиден или отсутствует
                if (bakIsValid) {
                    console.warn(`WiseJSON Collection ('${this.collectionName}') RECOVERY: Восстановление "${mainP}" из "${bakP}" для сегмента "${baseName}".`);
                    if (await this._pathExists(mainP)) await fs.unlink(mainP); // Удаляем поврежденный основной
                    await fs.rename(bakP, mainP);
                    if (await this._pathExists(newP)) await fs.unlink(newP); // Удаляем .new, так как .bak приоритетнее и уже восстановлен
                    for (const tmpP of tmpFiles) if (await this._pathExists(tmpP)) await fs.unlink(tmpP);
                    continue;
                }

                if (newIsValid) {
                    console.warn(`WiseJSON Collection ('${this.collectionName}') RECOVERY: Использование временного файла "${newP}" как основного "${mainP}" для сегмента "${baseName}".`);
                    if (await this._pathExists(mainP)) await fs.unlink(mainP); // Удаляем поврежденный основной (если он был)
                    if (await this._pathExists(bakP)) await fs.unlink(bakP);  // .bak невалиден или отсутствует, .new - лучший кандидат
                    await fs.rename(newP, mainP);
                    for (const tmpP of tmpFiles) if (await this._pathExists(tmpP)) await fs.unlink(tmpP);
                    continue;
                }
                
                // Нет валидных файлов для восстановления этого сегмента
                console.warn(`WiseJSON Collection ('${this.collectionName}') RECOVERY: Для сегмента "${baseName}" не найдено валидных файлов для восстановления. Удаление всех остатков (.json, .bak, .new, .tmp).`);
                if (await this._pathExists(mainP)) await fs.unlink(mainP);
                if (await this._pathExists(bakP)) await fs.unlink(bakP);
                if (await this._pathExists(newP)) await fs.unlink(newP);
                for (const tmpP of tmpFiles) if (await this._pathExists(tmpP)) await fs.unlink(tmpP);

            } catch (error) {
                console.error(`WiseJSON Collection ('${this.collectionName}') RECOVERY ERROR: Ошибка при обработке файлов для сегмента "${baseName}": ${error.message}`, error.stack);
                // Не перебрасываем ошибку здесь, чтобы попытаться восстановить другие сегменты
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
            // initPromise может быть отклонен, и эта ошибка будет передана дальше
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
     * @throws {Error} Если произошла ошибка чтения директории (кроме ENOENT).
     */
    async _getActualSegmentFiles() { 
        try {
            const files = await fs.readdir(this.collectionDirectoryPath);
            return files
                .filter(file => file.startsWith(`${this.collectionName}_`) && file.endsWith('.json'))
                .sort((a, b) => {
                    const indexA = this._getSegmentIndexFromName(a);
                    const indexB = this._getSegmentIndexFromName(b);
                    return indexA - indexB; // Сортировка по возрастанию индекса
                });
        } catch (error) {
            if (error.code === 'ENOENT') return []; // Директория еще не создана или была удалена
            // Другие ошибки чтения директории являются проблемами
            const errorMessage = `WiseJSON Collection ('${this.collectionName}') ERROR (_getActualSegmentFiles): Ошибка чтения директории "${this.collectionDirectoryPath}": ${error.message}`;
            console.error(errorMessage, error.stack);
            throw new Error(errorMessage);
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
            const errorMessage = `WiseJSON Collection ('${this.collectionName}'): Сегмент "${segmentPath}" поврежден или нечитаем. (Исходная ошибка: ${error.message})`;
            // Логируем только если это новая ошибка, а не повторное логирование из _isValidJsonFile
            if (!error.message.includes("поврежден или нечитаем")) {
                 console.error(errorMessage, error.stack);
            }
            throw new Error(errorMessage);
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
                    const errorMsg = `WiseJSON Collection ('${this.collectionName}') WRITE ERROR: Ошибка создания .bak для "${segmentPath}": ${bakError.message}. Откат: удаление ${newPath}.`;
                    console.error(errorMsg, bakError.stack);
                    try { await fs.unlink(newPath); } catch {} 
                    throw new Error(errorMsg); // Перебрасываем новую ошибку с контекстом
                }
            }

            try {
                await fs.rename(newPath, segmentPath);
            } catch (finalRenameError) {
                const errorMsg = `WiseJSON Collection ('${this.collectionName}') WRITE ERROR: Ошибка переименования .new в "${segmentPath}": ${finalRenameError.message}. Попытка отката.`;
                console.error(errorMsg, finalRenameError.stack);
                if (backupAttemptedAndMainExisted && await this._pathExists(bakPath)) { 
                    try {
                        // Если основной файл поврежден после неудачного rename, удаляем его перед восстановлением .bak
                        if(await this._pathExists(segmentPath) && !(await this._isValidJsonFile(segmentPath))) {
                             try { await fs.unlink(segmentPath); } catch (e) { if (e.code !== 'ENOENT') console.error(`WiseJSON Collection ('${this.collectionName}') WRITE WARN: Не удалось удалить ${segmentPath} перед восстановлением .bak`, e.message); }
                        } else if (await this._pathExists(segmentPath)) {
                            // Основной файл существует и, возможно, валиден (если rename .new упал не из-за этого)
                        }
                        await fs.rename(bakPath, segmentPath); 
                        console.warn(`WiseJSON Collection ('${this.collectionName}') WRITE: Успешно восстановлен .bak для "${segmentPath}".`);
                    } catch (restoreError) {
                        console.error(`WiseJSON Collection ('${this.collectionName}') WRITE CRITICAL: Ошибка восстановления .bak для "${segmentPath}": ${restoreError.message}.`);
                        // Здесь можно было бы добавить исходную ошибку finalRenameError в сообщение restoreError, но это усложнит
                    }
                }
                try { await fs.unlink(newPath); } catch (e){ if(e.code !== 'ENOENT') console.error(`WiseJSON Collection ('${this.collectionName}') WRITE ERROR: Не удалось удалить ${newPath} при откате финального rename: ${e.message}`);}
                throw new Error(errorMsg); // Перебрасываем новую ошибку с контекстом
            }

            // Успешная запись, удаляем .bak, если он был создан
            if (backupAttemptedAndMainExisted && await this._pathExists(bakPath)) {
                try { await fs.unlink(bakPath); } catch (e) { if (e.code !== 'ENOENT') console.warn(`WiseJSON Collection ('${this.collectionName}') WRITE WARN: Не удалось удалить ${bakPath} после успешной записи: ${e.message}`); }
            }
            return Buffer.byteLength(jsonData, 'utf8');
        } catch (error) {
            // Если ошибка не из этого метода, она уже содержит префикс или будет обернута выше
            // Попытка удалить .new, если он мог остаться
            if (await this._pathExists(newPath) && (error.path !== newPath || (error.syscall && error.syscall !== 'unlink'))) {
                 try { await fs.unlink(newPath); } catch {}
            }
            // Если это уже ошибка с префиксом, не оборачиваем ее снова
            if (error.message.startsWith(`WiseJSON Collection ('${this.collectionName}')`)) {
                throw error;
            }
            // Оборачиваем неизвестные ошибки
            const wrapperErrorMsg = `WiseJSON Collection ('${this.collectionName}') _writeSegmentDataInternal: ${error.message}`;
            // console.error(wrapperErrorMsg, error.stack); // Логирование может быть избыточным, если ошибка уже залогирована выше
            throw new Error(wrapperErrorMsg);
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
                // Это информационное сообщение, не ошибка самой очереди
                console.warn(`WiseJSON Collection ('${this.collectionName}') Info: Предыдущая операция в очереди завершилась с ошибкой: ${prevErrInQueue.message}. Запускаем следующую...`);
                return Promise.resolve(); // Не прерываем очередь из-за ошибки предыдущей операции
            })
            .then(() => this._ensureInitialized()) 
            .then(() => operationFn()) // Выполняем текущую операцию
            .catch(currentOperationError => {
                // Ошибка текущей операции будет возвращена вызывающему коду.
                // Если она еще не имеет нашего префикса, добавляем его.
                if (!currentOperationError.message.startsWith(`WiseJSON Collection ('${this.collectionName}')`)) {
                    const descriptiveError = new Error(`WiseJSON Collection ('${this.collectionName}'): ${currentOperationError.message}`);
                    descriptiveError.stack = currentOperationError.stack; // Сохраняем оригинальный стек
                    return Promise.reject(descriptiveError);
                }
                return Promise.reject(currentOperationError);
            });
        this.writeQueue = operationPromise; 
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
                    Promise.resolve(listener(...args)).catch(listenerError => {
                        console.error(`WiseJSON Collection ('${this.collectionName}') Event Listener Error: Ошибка в слушателе события '${eventName}': ${listenerError.message}`, listenerError.stack);
                    });
                } catch (syncError) { 
                    console.error(`WiseJSON Collection ('${this.collectionName}') Event Listener Error: Синхронная ошибка при вызове слушателя события '${eventName}': ${syncError.message}`, syncError.stack);
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
            throw new Error(`WiseJSON Collection ('${this.collectionName}'): Слушатель должен быть функцией.`);
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
        if (!listener) { // Если слушатель не указан, удаляем всех для этого события
            delete this._listeners[eventName];
        } else {
            this._listeners[eventName] = this._listeners[eventName].filter(l => l !== listener);
            if (this._listeners[eventName].length === 0) {
                delete this._listeners[eventName]; // Удаляем массив, если он стал пустым
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

        // Проверка размера сегмента перед добавлением
        const tempNewDataForSizeCheck = [...currentSegmentData, newItem];
        const jsonDataSize = Buffer.byteLength(JSON.stringify(tempNewDataForSizeCheck, null, this.options.jsonIndent), 'utf8');

        if (jsonDataSize > this.options.maxSegmentSizeBytes && !isCurrentSegmentEmpty) { // Создаем новый сегмент только если текущий не пуст
            this.currentSegmentIndex++;
            // Записываем новый элемент в новый сегмент
            await this._writeSegmentDataInternal(this.currentSegmentIndex, [newItem], true); 
        } else {
            // Добавляем в текущий сегмент
            currentSegmentData.push(newItem);
            // Если это первая запись в самый первый сегмент (index 0), то он считается "новым" файлом
            const isEffectivelyNewFile = this.currentSegmentIndex === 0 && isCurrentSegmentEmpty;
            await this._writeSegmentDataInternal(this.currentSegmentIndex, currentSegmentData, isEffectivelyNewFile);
        }
        this._emit('afterInsert', { ...newItem });
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
                // Файл сегмента не "новый", так как мы его модифицируем
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
     * Операция добавляется в очередь записи.
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
            throw new Error(`WiseJSON Collection ('${this.collectionName}'): queryFunction для find должен быть функцией.`);
        }
        const allItems = await this.getAll(); // getAll уже вызывает _ensureInitialized
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
            throw new Error(`WiseJSON Collection ('${this.collectionName}'): queryFunction для findOne должен быть функцией.`);
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
     * Операция выполняется немедленно, не вставая в очередь записи.
     * @param {string} id - Уникальный идентификатор документа.
     * @returns {Promise<object|null>} - Найденный документ или null.
     * @throws {Error} Если ID не является непустой строкой.
     */
    async getById(id) {
        if (!id || typeof id !== 'string') {
            throw new Error(`WiseJSON Collection ('${this.collectionName}'): ID для getById должен быть непустой строкой.`);
        }
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
            console.warn(`WiseJSON Collection ('${this.collectionName}'): Попытка изменить _id на '${cleanUpdates._id}' для документа с ID '${id}' при обновлении. Поле _id в объекте updates будет проигнорировано.`);
        }
        delete cleanUpdates._id; 
        delete cleanUpdates.createdAt; 
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
                throw new Error(`WiseJSON Collection ('${this.collectionName}'): ID для remove должен быть непустой строкой.`);
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

                if (newData.length < originalLength) { 
                    // Если после удаления сегмент стал пустым и это единственный сегмент _0.json,
                    // он должен быть помечен как "brand new" (т.е. перезаписан как пустой массив без .bak).
                    // Однако, если есть другие сегменты, или это не _0.json, то это просто обновление.
                    // Простейший случай: всегда считать isBrandNewSegmentFile=false при удалении,
                    // так как мы модифицируем существующий файл.
                    // Если newData пустой, файл сегмента просто будет содержать `[]`.
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
                throw new Error(`WiseJSON Collection ('${this.collectionName}'): query для upsert должен быть объектом или функцией.`);
            }
            if (!dataToUpsert || typeof dataToUpsert !== 'object') {
                throw new Error(`WiseJSON Collection ('${this.collectionName}'): dataToUpsert для upsert должен быть объектом.`);
            }

            const queryFn = typeof query === 'function' ? query : (doc =>
                Object.keys(query).every(key => doc[key] === query[key])
            );
            
            const existingDocument = await this.findOne(queryFn); // findOne вызывает _ensureInitialized

            if (existingDocument) {
                const updatesForRaw = { ...dataToUpsert };
                delete updatesForRaw._id; 
                delete updatesForRaw.createdAt;
                const updatedDocument = await this._rawUpdate(existingDocument._id, updatesForRaw);
                return { document: updatedDocument, operation: 'updated' };
            } else {
                let documentToInsert = {};
                if (typeof query === 'object' && query !== null && !Array.isArray(query)) { 
                    documentToInsert = { ...query };
                }
                documentToInsert = { ...documentToInsert, ...dataToUpsert };
                if (options.setOnInsert && typeof options.setOnInsert === 'object') {
                    documentToInsert = { ...documentToInsert, ...options.setOnInsert };
                }
                // _rawInsert корректно обработает _id, createdAt, updatedAt
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
                console.warn(`WiseJSON Collection ('${this.collectionName}') WARN (getCollectionStats): Не удалось получить размер для сегмента "${segmentPath}": ${error.message}`);
            }
        }
        
        const documentCount = await this.count(); 

        return {
            documentCount,
            segmentCount,
            totalDiskSizeBytes,
            options: { ...this.options } 
        };
    }

    /**
     * Удаляет все документы из коллекции.
     * Все существующие файлы сегментов будут перезаписаны пустыми массивами.
     * Индекс текущего сегмента будет сброшен на 0.
     * Операция добавляется в очередь записи.
     * @returns {Promise<void>}
     */
    async clear() {
        return this._enqueueWriteOperation(async () => {
            const segmentFiles = await this._getActualSegmentFiles();
            
            for (const segmentFileName of segmentFiles) {
                const segmentIndex = this._getSegmentIndexFromName(segmentFileName);
                if (segmentIndex === -1) continue; // Пропускаем, если имя файла некорректно

                // Перезаписываем каждый сегмент пустым массивом.
                // Помечаем как "brand new" только если это сегмент _0.json и он единственный,
                // чтобы избежать ненужного .bak для остальных или если _0.json не пуст.
                // Проще всего считать, что мы модифицируем файлы, поэтому isBrandNewSegmentFile = false,
                // кроме случая, когда это самый первый сегмент _0.json, и он единственный.
                // Однако, для clear() проще просто перезаписать все как существующие.
                // Если сегмент _0.json единственный, то _writeSegmentDataInternal с isBrandNewSegmentFile=true
                // создаст его без .bak, если он был удален или пуст.
                // Здесь, для простоты, мы просто перезаписываем содержимое существующих файлов.
                await this._writeSegmentDataInternal(segmentIndex, [], false);
            }

            // Если после очистки не осталось сегмента _0.json (маловероятно, если мы только перезаписываем),
            // или если мы хотим гарантировать его существование:
            if (!segmentFiles.some(name => this._getSegmentIndexFromName(name) === 0)) {
                await this._writeSegmentDataInternal(0, [], true);
            }
            
            this.currentSegmentIndex = 0; // Сбрасываем текущий сегмент на начальный
            
            // Здесь можно было бы добавить событие 'afterClear', если нужно
            // this._emit('afterClear');
            console.log(`WiseJSON Collection ('${this.collectionName}'): Коллекция очищена.`);
        });
    }
}

module.exports = Collection;