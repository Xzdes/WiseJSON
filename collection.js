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
     */
    constructor(collectionName, dbDirectoryPath, options = {}) {
        this.collectionName = collectionName;
        this.collectionDirectoryPath = path.join(dbDirectoryPath, collectionName);
        this.options = {
            maxSegmentSizeBytes: options.maxSegmentSizeBytes || DEFAULT_MAX_SEGMENT_SIZE_BYTES,
            jsonIndent: options.jsonIndent !== undefined ? options.jsonIndent : DEFAULT_JSON_INDENT,
        };

        this.currentSegmentIndex = 0; // Индекс текущего сегмента для записи
        this.writeQueue = Promise.resolve(); // Очередь для последовательного выполнения операций записи
        this.isInitialized = false;
        this.initPromise = this._initialize(); // Промис, который разрешается после завершения инициализации
    }

    /**
     * Асинхронно инициализирует коллекцию: создает директорию, определяет/создает начальный сегмент.
     * @private
     */
    async _initialize() {
        try {
            await fs.mkdir(this.collectionDirectoryPath, { recursive: true });
            const segmentFiles = await this._getSegmentFiles();

            if (segmentFiles.length > 0) {
                // Если сегменты существуют, определяем индекс последнего
                const lastSegmentName = segmentFiles[segmentFiles.length - 1];
                this.currentSegmentIndex = this._getSegmentIndexFromName(lastSegmentName);
            } else {
                // Если сегментов нет, создаем первый пустой сегмент (_0.json)
                await this._writeSegmentData(this.currentSegmentIndex, []);
            }
            this.isInitialized = true;
        } catch (error) {
            console.error(`WiseJSON: Ошибка инициализации коллекции "${this.collectionName}": ${error.message}`, error.stack);
            throw error; // Перебрасываем ошибку для обработки выше
        }
    }

    /**
     * Гарантирует, что коллекция была инициализирована.
     * @private
     */
    async _ensureInitialized() {
        if (!this.isInitialized) {
            await this.initPromise;
        }
    }

    /**
     * Формирует полный путь к файлу-сегменту.
     * @param {number} index - Индекс сегмента.
     * @returns {string} Полный путь к файлу сегмента.
     * @private
     */
    _getSegmentPath(index) {
        return path.join(this.collectionDirectoryPath, `${this.collectionName}_${index}.json`);
    }

    /**
     * Извлекает индекс сегмента из его имени файла.
     * @param {string} fileName - Имя файла сегмента.
     * @returns {number} Индекс сегмента.
     * @private
     */
    _getSegmentIndexFromName(fileName) {
        const match = fileName.match(/_(\d+)\.json$/);
        return match ? parseInt(match[1], 10) : 0;
    }

    /**
     * Получает отсортированный список имен файлов-сегментов коллекции.
     * @returns {Promise<string[]>} Массив имен файлов.
     * @private
     */
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

    /**
     * Читает и парсит данные из указанного файла-сегмента.
     * @param {number} index - Индекс сегмента.
     * @returns {Promise<object[]>} Массив документов из сегмента.
     * @throws {Error} Если файл сегмента поврежден или нечитаем.
     * @private
     */
    async _readSegmentData(index) {
        const segmentPath = this._getSegmentPath(index);
        try {
            const fileContent = await fs.readFile(segmentPath, 'utf-8');
            return JSON.parse(fileContent);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return []; 
            }
            // ИЗМЕНЕНИЕ ДЛЯ ОШИБКИ 2 (Вариант А)
            const userFriendlyMessage = `WiseJSON: Сегмент "${segmentPath}" поврежден или нечитаем. (Исходная ошибка: ${error.message})`;
            console.error(userFriendlyMessage, error.stack);
            throw new Error(userFriendlyMessage);
        }
    }

    /**
     * Записывает данные в указанный файл-сегмент, используя временный файл и переименование.
     * @param {number} index - Индекс сегмента.
     * @param {object[]} data - Массив документов для записи.
     * @returns {Promise<number>} Размер записанных данных в байтах.
     * @throws {Error} Если произошла ошибка записи.
     * @private
     */
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

    /**
     * Добавляет асинхронную операцию записи в очередь для последовательного выполнения.
     * @param {Function} operationFn - Асинхронная функция, выполняющая операцию записи.
     * @returns {Promise<any>} Промис результата выполнения операции.
     * @private
     */
    _enqueueWriteOperation(operationFn) {
        // ИЗМЕНЕНИЕ ДЛЯ ОШИБКИ 1
        const operationPromise = this.writeQueue
            .catch(prevErrInQueue => {
                // Этот catch обрабатывает ситуацию, если *предыдущая* операция в очереди завершилась ошибкой.
                // Мы логируем эту ошибку, но позволяем текущей операции попытаться выполниться.
                // Это предотвращает полную блокировку очереди из-за одной неудачной операции,
                // если последующие операции могут быть независимы.
                // Для тестов, где мы намеренно вызываем ошибки, это поможет их изолировать.
                console.warn(`WiseJSON Info: Предыдущая операция в очереди для "${this.collectionName}" завершилась с ошибкой: ${prevErrInQueue.message}. Запускаем следующую...`);
                return Promise.resolve(); // "Сбрасываем" состояние ошибки для текущей цепочки .then()
            })
            .then(() => this._ensureInitialized()) // Гарантируем инициализацию перед текущей операцией
            .then(() => operationFn()) // Выполняем текущую операцию
            .catch(currentOperationError => {
                // Этот catch ловит ошибку, выброшенную *текущей* operationFn или _ensureInitialized.
                // Мы должны перебросить именно эту ошибку, чтобы вызывающий код ее получил.
                // console.error(`WiseJSON DEBUG: Ошибка в текущей операции для "${this.collectionName}": ${currentOperationError.message}`);
                return Promise.reject(currentOperationError);
            });

        this.writeQueue = operationPromise; // Обновляем "хвост" очереди на промис текущей операции
        return operationPromise; // Возвращаем промис текущей операции
    }

    /**
     * Вставляет новый документ в коллекцию.
     * @param {object} itemData - Данные документа для вставки. Поле _id будет проигнорировано.
     * @returns {Promise<object>} Вставленный документ с сгенерированным _id, createdAt, updatedAt.
     */
    async insert(itemData) {
        return this._enqueueWriteOperation(async () => {
            if (!itemData || typeof itemData !== 'object') {
                throw new Error("WiseJSON: Данные для вставки (itemData) должны быть объектом.");
            }
            const cleanItemData = { ...itemData };
            delete cleanItemData._id;
            delete cleanItemData.createdAt;
            delete cleanItemData.updatedAt;

            let currentSegmentData = await this._readSegmentData(this.currentSegmentIndex);
            const newItem = {
                _id: uuidv4(),
                ...cleanItemData,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };

            const potentialNewData = [...currentSegmentData, newItem];
            const jsonDataSize = Buffer.byteLength(JSON.stringify(potentialNewData, null, this.options.jsonIndent), 'utf8');

            if (jsonDataSize > this.options.maxSegmentSizeBytes && currentSegmentData.length > 0) {
                this.currentSegmentIndex++;
                await this._writeSegmentData(this.currentSegmentIndex, [newItem]);
            } else {
                currentSegmentData.push(newItem);
                await this._writeSegmentData(this.currentSegmentIndex, currentSegmentData);
            }
            return newItem;
        });
    }

    /**
     * Получает все документы из коллекции.
     * @returns {Promise<object[]>} Массив всех документов.
     */
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

    /**
     * Находит документы, соответствующие функции-предикату.
     * @param {function(object): boolean} queryFunction - Функция-фильтр.
     * @returns {Promise<object[]>} Массив найденных документов.
     */
    async find(queryFunction) {
        if (typeof queryFunction !== 'function') {
            throw new Error("WiseJSON: queryFunction для find должен быть функцией.");
        }
        const allItems = await this.getAll();
        return allItems.filter(queryFunction);
    }

    /**
     * Находит первый документ, соответствующий функции-предикату.
     * @param {function(object): boolean} queryFunction - Функция-фильтр.
     * @returns {Promise<object|null>} Найденный документ или null.
     */
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

    /**
     * Находит документ по его _id.
     * @param {string} id - Уникальный идентификатор документа.
     * @returns {Promise<object|null>} Найденный документ или null.
     */
    async getById(id) {
        if (!id || typeof id !== 'string') {
            throw new Error("WiseJSON: ID для getById должен быть непустой строкой.");
        }
        return this.findOne(item => item._id === id);
    }

    /**
     * Обновляет документ с указанным ID.
     * @param {string} id - ID документа для обновления.
     * @param {object} updates - Объект с полями для обновления. Поля _id и createdAt будут проигнорированы.
     * @returns {Promise<object|null>} Обновленный документ или null, если документ не найден.
     */
    async update(id, updates) {
        return this._enqueueWriteOperation(async () => {
            if (!id || typeof id !== 'string') {
                throw new Error("WiseJSON: ID для update должен быть непустой строкой.");
            }
            if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
                throw new Error("WiseJSON: Объект обновлений (updates) не предоставлен, пуст или не является объектом.");
            }

            const cleanUpdates = { ...updates };
            if (cleanUpdates._id && cleanUpdates._id !== id) {
                console.warn(`WiseJSON: Попытка изменить _id на '${cleanUpdates._id}' для документа с ID '${id}' при обновлении. Поле _id не будет изменено.`);
            }
            delete cleanUpdates._id; 
            delete cleanUpdates.createdAt; 

            const segmentFiles = await this._getSegmentFiles();
            for (const segmentFileName of segmentFiles) {
                const segmentIndex = this._getSegmentIndexFromName(segmentFileName);
                let segmentData = await this._readSegmentData(segmentIndex); 
                
                const itemIndex = segmentData.findIndex(item => item._id === id);

                if (itemIndex !== -1) {
                    const updatedItem = {
                        ...segmentData[itemIndex], 
                        ...cleanUpdates,           
                        updatedAt: new Date().toISOString(), 
                    };
                    segmentData[itemIndex] = updatedItem; 
                    await this._writeSegmentData(segmentIndex, segmentData); 
                    return updatedItem;
                }
            }
            return null; 
        });
    }

    /**
     * Удаляет документ с указанным ID.
     * @param {string} id - ID документа для удаления.
     * @returns {Promise<boolean>} true, если документ был удален, false - если не найден.
     */
    async remove(id) {
        return this._enqueueWriteOperation(async () => {
            if (!id || typeof id !== 'string') {
                throw new Error("WiseJSON: ID для remove должен быть непустой строкой.");
            }
            const segmentFiles = await this._getSegmentFiles();
            for (const segmentFileName of segmentFiles) {
                const segmentIndex = this._getSegmentIndexFromName(segmentFileName);
                let segmentData = await this._readSegmentData(segmentIndex); 

                const initialLength = segmentData.length;
                const newData = segmentData.filter(item => item._id !== id);

                if (newData.length < initialLength) {
                    await this._writeSegmentData(segmentIndex, newData);
                    return true;
                }
            }
            return false; 
        });
    }
}

module.exports = Collection;