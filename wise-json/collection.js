// wise-json/collection.js
const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // Убедитесь, что uuid установлен: npm install uuid

/**
 * @constant {number} DEFAULT_MAX_SEGMENT_SIZE_BYTES - Максимальный размер файла-сегмента по умолчанию (1MB).
 */
const DEFAULT_MAX_SEGMENT_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * @constant {number | null} DEFAULT_JSON_INDENT - Отступ для форматирования JSON по умолчанию (2 пробела).
 *                                                Null или 0 для компактного JSON.
 */
const DEFAULT_JSON_INDENT = 2;

/**
 * Класс Collection управляет данными одной коллекции, хранящимися в сегментированных JSON-файлах.
 */
class Collection {
    /**
     * Создает экземпляр Collection.
     * @param {string} collectionName - Имя коллекции.
     * @param {string} dbDirectoryPath - Путь к корневой директории базы данных WiseJSON.
     * @param {object} [options={}] - Опции для этой коллекции.
     * @param {number} [options.maxSegmentSizeBytes=DEFAULT_MAX_SEGMENT_SIZE_BYTES] - Максимальный размер сегмента в байтах.
     * @param {number | null} [options.jsonIndent=DEFAULT_JSON_INDENT] - Отступ для JSON-файлов.
     * @param {function(): string|number} [options.idGenerator] - Функция для генерации ID. По умолчанию uuidv4.
     */
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
        this.initPromise = this._initialize();

        this._listeners = {}; // Для хуков/событий
    }

    async _initialize() {
        try {
            await fs.mkdir(this.collectionDirectoryPath, { recursive: true });
            const segmentFiles = await this._getSegmentFiles();
            if (segmentFiles.length > 0) {
                const lastSegmentName = segmentFiles[segmentFiles.length - 1];
                this.currentSegmentIndex = this._getSegmentIndexFromName(lastSegmentName);
            } else {
                await this._writeSegmentData(this.currentSegmentIndex, []);
            }
            this.isInitialized = true;
        } catch (error) {
            console.error(`WiseJSON: Ошибка инициализации коллекции "${this.collectionName}": ${error.message}`, error.stack);
            throw error;
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

    _getSegmentIndexFromName(fileName) {
        const match = fileName.match(/_(\d+)\.json$/);
        return match ? parseInt(match[1], 10) : 0;
    }

    async _getSegmentFiles() {
        try {
            const files = await fs.readdir(this.collectionDirectoryPath);
            return files
                .filter(file => file.startsWith(`${this.collectionName}_`) && file.endsWith('.json'))
                .sort((a, b) => this._getSegmentIndexFromName(a) - this._getSegmentIndexFromName(b));
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new Error(`WiseJSON: Директория коллекции "${this.collectionDirectoryPath}" не найдена.`);
            }
            throw error;
        }
    }

    async _readSegmentData(index) {
        const segmentPath = this._getSegmentPath(index);
        try {
            const fileContent = await fs.readFile(segmentPath, 'utf-8');
            return JSON.parse(fileContent);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return []; 
            }
            const userFriendlyMessage = `WiseJSON: Сегмент "${segmentPath}" поврежден или нечитаем. (Исходная ошибка: ${error.message})`;
            console.error(userFriendlyMessage, error.stack); // Логируем для администратора
            throw new Error(userFriendlyMessage); // Выбрасываем для обработки приложением
        }
    }

    async _writeSegmentData(index, data) {
        const segmentPath = this._getSegmentPath(index);
        const tempSegmentPath = `${segmentPath}.tmp.${uuidv4()}`; 
        try {
            const jsonData = JSON.stringify(data, null, this.options.jsonIndent);
            await fs.writeFile(tempSegmentPath, jsonData, 'utf-8');
            await fs.rename(tempSegmentPath, segmentPath);
            return Buffer.byteLength(jsonData, 'utf8');
        } catch (error) {
            const errorMessage = `WiseJSON: Ошибка записи в сегмент "${segmentPath}": ${error.message}`;
            console.error(errorMessage, error.stack);
            try {
                await fs.access(tempSegmentPath);
                await fs.unlink(tempSegmentPath);
            } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') {
                    console.warn(`WiseJSON: Не удалось удалить временный файл "${tempSegmentPath}" после ошибки записи: ${unlinkError.message}`);
                }
            }
            throw new Error(errorMessage);
        }
    }

    _enqueueWriteOperation(operationFn) {
        const operationPromise = this.writeQueue
            .catch(prevErrInQueue => {
                // Этот catch "поглощает" ошибку предыдущей операции в очереди,
                // позволяя следующей операции попытаться выполниться.
                // Полезно для тестов, где ошибки вызываются намеренно.
                console.warn(`WiseJSON Info: Предыдущая операция в очереди для "${this.collectionName}" завершилась с ошибкой: ${prevErrInQueue.message}. Запускаем следующую...`);
                return Promise.resolve(); 
            })
            .then(() => this._ensureInitialized())
            .then(() => operationFn()) // Выполняем текущую операцию
            .catch(currentOperationError => {
                // Перебрасываем ошибку текущей операции, чтобы вызывающий код ее получил.
                return Promise.reject(currentOperationError);
            });
        this.writeQueue = operationPromise; // Обновляем "хвост" очереди
        return operationPromise; // Возвращаем промис текущей операции
    }

    _emit(eventName, ...args) {
        const listeners = this._listeners[eventName];
        if (listeners && listeners.length > 0) {
            listeners.forEach(listener => {
                try {
                    Promise.resolve(listener(...args)).catch(listenerError => {
                        console.error(`WiseJSON: Ошибка в слушателе события '${eventName}' для коллекции '${this.collectionName}': ${listenerError.message}`, listenerError.stack);
                    });
                } catch (syncError) { 
                    console.error(`WiseJSON: Синхронная ошибка при вызове слушателя события '${eventName}' для коллекции '${this.collectionName}': ${syncError.message}`, syncError.stack);
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
        // itemDataToInsert - это уже "чистые" данные, возможно с _id, createdAt, updatedAt от upsert
        const newItem = {
            _id: itemDataToInsert._id || this.options.idGenerator(),
            ...itemDataToInsert, // Применяем все поля из itemDataToInsert
            // Гарантируем, что createdAt и updatedAt будут установлены, если их нет
            createdAt: itemDataToInsert.createdAt || new Date().toISOString(),
            updatedAt: itemDataToInsert.updatedAt || new Date().toISOString(),
        };
        // Перезаписываем на случай, если они были в itemDataToInsert, но не как главные поля
        newItem._id = newItem._id; 
        newItem.createdAt = newItem.createdAt;
        newItem.updatedAt = newItem.updatedAt;


        let currentSegmentData = await this._readSegmentData(this.currentSegmentIndex);
        
        const potentialNewData = [...currentSegmentData, newItem];
        const jsonDataSize = Buffer.byteLength(JSON.stringify(potentialNewData, null, this.options.jsonIndent), 'utf8');

        if (jsonDataSize > this.options.maxSegmentSizeBytes && currentSegmentData.length > 0) {
            this.currentSegmentIndex++;
            await this._writeSegmentData(this.currentSegmentIndex, [newItem]);
        } else {
            currentSegmentData.push(newItem);
            await this._writeSegmentData(this.currentSegmentIndex, currentSegmentData);
        }
        this._emit('afterInsert', { ...newItem }); 
        return newItem;
    }

    async _rawUpdate(id, updatesToApply) {
        // updatesToApply - это "чистые" данные для обновления, без _id, createdAt
        let originalDocumentSnapshot = null; 
        const segmentFiles = await this._getSegmentFiles();

        for (const segmentFileName of segmentFiles) {
            const segmentIndex = this._getSegmentIndexFromName(segmentFileName);
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
                await this._writeSegmentData(segmentIndex, segmentData);
                this._emit('afterUpdate', { ...updatedItem }, originalDocumentSnapshot); 
                return updatedItem;
            }
        }
        return null;
    }

    async insert(itemData) {
        const cleanItemData = { ...itemData };
        // Публичный insert всегда генерирует новый _id и даты
        delete cleanItemData._id; 
        delete cleanItemData.createdAt;
        delete cleanItemData.updatedAt;
        
        // _rawInsert использует this.options.idGenerator() и new Date() если поля не переданы
        return this._enqueueWriteOperation(() => this._rawInsert(cleanItemData));
    }

    async getAll() {
        await this._ensureInitialized();
        const allItems = [];
        const segmentFiles = await this._getSegmentFiles();
        for (const segmentFileName of segmentFiles) {
            const index = this._getSegmentIndexFromName(segmentFileName);
            const segmentData = await this._readSegmentData(index);
            allItems.push(...segmentData);
        }
        return allItems;
    }

    async find(queryFunction) {
        if (typeof queryFunction !== 'function') {
            throw new Error("WiseJSON: queryFunction для find должен быть функцией.");
        }
        const allItems = await this.getAll();
        return allItems.filter(queryFunction);
    }

    async findOne(queryFunction) {
        if (typeof queryFunction !== 'function') {
            throw new Error("WiseJSON: queryFunction для findOne должен быть функцией.");
        }
        await this._ensureInitialized();
        const segmentFiles = await this._getSegmentFiles();
        for (const segmentFileName of segmentFiles) {
            const index = this._getSegmentIndexFromName(segmentFileName);
            const segmentData = await this._readSegmentData(index);
            const foundItem = segmentData.find(queryFunction);
            if (foundItem) {
                return foundItem;
            }
        }
        return null;
    }

    async getById(id) {
        if (!id || typeof id !== 'string') {
            throw new Error("WiseJSON: ID для getById должен быть непустой строкой.");
        }
        return this.findOne(item => item._id === id);
    }

    async update(id, updates) {
        const cleanUpdates = { ...updates };
        if (cleanUpdates._id && cleanUpdates._id !== id) {
            console.warn(`WiseJSON: Попытка изменить _id на '${cleanUpdates._id}' для документа с ID '${id}' при обновлении. Поле _id в объекте updates будет проигнорировано.`);
        }
        delete cleanUpdates._id; 
        delete cleanUpdates.createdAt; 

        return this._enqueueWriteOperation(() => this._rawUpdate(id, cleanUpdates));
    }

    async remove(id) {
        return this._enqueueWriteOperation(async () => {
            if (!id || typeof id !== 'string') {
                throw new Error("WiseJSON: ID для remove должен быть непустой строкой.");
            }
            let removedDocumentSnapshot = null; 
            const segmentFiles = await this._getSegmentFiles();
            for (const segmentFileName of segmentFiles) {
                const segmentIndex = this._getSegmentIndexFromName(segmentFileName);
                let segmentData = await this._readSegmentData(segmentIndex);
                
                const itemToRemoveIndex = segmentData.findIndex(item => item._id === id);
                if (itemToRemoveIndex !== -1) {
                    removedDocumentSnapshot = { ...segmentData[itemToRemoveIndex] }; 
                }

                const newData = segmentData.filter(item => item._id !== id);

                if (newData.length < segmentData.length) { 
                    await this._writeSegmentData(segmentIndex, newData);
                    if (removedDocumentSnapshot) { 
                        this._emit('afterRemove', id, removedDocumentSnapshot);
                    }
                    return true;
                }
            }
            return false;
        });
    }

    async count(queryFunction) {
        await this._ensureInitialized();
        let documentCount = 0;
        const segmentFiles = await this._getSegmentFiles();
        for (const segmentFileName of segmentFiles) {
            const index = this._getSegmentIndexFromName(segmentFileName);
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

    async upsert(query, dataToUpsert, options = {}) {
        return this._enqueueWriteOperation(async () => {
            // console.log(`WISEJSON UPSERT: Начало. Коллекция: ${this.collectionName}. Query: ${typeof query === 'function' ? 'function' : JSON.stringify(query)}`);

            if (!query || (typeof query !== 'object' && typeof query !== 'function')) {
                throw new Error("WiseJSON: query для upsert должен быть объектом или функцией.");
            }
            if (!dataToUpsert || typeof dataToUpsert !== 'object') {
                throw new Error("WiseJSON: dataToUpsert для upsert должен быть объектом.");
            }

            const queryFn = typeof query === 'function' ? query : (doc =>
                Object.keys(query).every(key => doc[key] === query[key])
            );

            // console.log(`WISEJSON UPSERT: Перед findOne для ${this.collectionName}`);
            const existingDocument = await this.findOne(queryFn);
            // console.log(`WISEJSON UPSERT: После findOne для ${this.collectionName}. existingDocument:`, existingDocument ? existingDocument._id : null);

            if (existingDocument) {
                // console.log(`WISEJSON UPSERT: Документ найден (${existingDocument._id}), ВЫЗОВ _rawUpdate...`);
                const updatesForRaw = { ...dataToUpsert };
                delete updatesForRaw._id; 
                delete updatesForRaw.createdAt;

                const updatedDocument = await this._rawUpdate(existingDocument._id, updatesForRaw);
                // console.log(`WISEJSON UPSERT: _rawUpdate завершен. updatedDocument:`, updatedDocument ? updatedDocument._id : null);
                return { document: updatedDocument, operation: 'updated' };
            } else {
                // console.log(`WISEJSON UPSERT: Документ не найден, ВЫЗОВ _rawInsert...`);
                let documentToInsert = {};
                if (typeof query === 'object' && query !== null) {
                    documentToInsert = { ...query };
                }
                documentToInsert = { ...documentToInsert, ...dataToUpsert };
                
                if (options.setOnInsert && typeof options.setOnInsert === 'object') {
                    documentToInsert = { ...documentToInsert, ...options.setOnInsert };
                }
                
                // _id, createdAt, updatedAt будут сгенерированы в _rawInsert, если их нет,
                // или взяты из documentToInsert, если они там есть (например, _id из query)
                // Очистим createdAt/updatedAt, чтобы _rawInsert их точно сгенерировал свежими
                // для новой записи, если только они не были специфично заданы в setOnInsert.
                // Но для простоты, _rawInsert сам позаботится о них.
                // Если _id был в query, он сохранится.
                delete documentToInsert.createdAt; 
                delete documentToInsert.updatedAt;

                const insertedDocument = await this._rawInsert(documentToInsert); 
                // console.log(`WISEJSON UPSERT: _rawInsert завершен. insertedDocument:`, insertedDocument ? insertedDocument._id : null);
                return { document: insertedDocument, operation: 'inserted' };
            }
        });
    }
}

module.exports = Collection;