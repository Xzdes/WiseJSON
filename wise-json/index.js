// wise-json/index.js
const fs = require('fs/promises');
const path = require('path');
const Collection = require('./collection');

/**
 * @class WiseJSON
 * @classdesc Основной класс для управления базой данных WiseJSON.
 * Предоставляет доступ к коллекциям данных.
 */
class WiseJSON {
    /**
     * Создает экземпляр WiseJSON.
     * @param {string} dbRootPath - Корневой путь к директории, где будут храниться данные базы.
     *                               Эта директория будет создана, если не существует.
     * @param {object} [globalOptions={}] - Глобальные опции, применяемые ко всем коллекциям по умолчанию.
     * @param {number} [globalOptions.maxSegmentSizeBytes] - Максимальный размер файла-сегмента в байтах.
     *                                                      По умолчанию используется значение из Collection.DEFAULT_MAX_SEGMENT_SIZE_BYTES.
     * @param {number|null} [globalOptions.jsonIndent] - Отступ для форматирования JSON-файлов (например, 2).
     *                                                 Передайте null или 0 для компактного JSON без отступов.
     *                                                 По умолчанию используется значение из Collection.DEFAULT_JSON_INDENT.
     * @param {function():string} [globalOptions.idGenerator] - Функция для генерации уникальных идентификаторов документов.
     *                                                          По умолчанию используется uuidv4.
     * @throws {Error} Если `dbRootPath` не является непустой строкой.
     */
    constructor(dbRootPath, globalOptions = {}) {
        if (!dbRootPath || typeof dbRootPath !== 'string') {
            // Сообщение об ошибке теперь с префиксом
            throw new Error("WiseJSON: Корневой путь к базе данных (dbRootPath) должен быть непустой строкой.");
        }
        this.dbRootPath = path.resolve(dbRootPath);
        this.globalOptions = {
            ...globalOptions 
        };
        /** 
         * @private
         * @type {Map<string, Collection>} 
         * Кеш для хранения инициализированных экземпляров коллекций.
         */
        this.collectionsCache = new Map();
        /** 
         * @private
         * @type {Map<string, Promise<Collection>>}
         * Карта для хранения промисов инициализации коллекций, которые создаются в данный момент.
         * Используется для предотвращения многократной инициализации одной и той же коллекции
         * при конкурентных запросах.
         */
        this.initializingCollections = new Map();
        /** 
         * @public
         * @type {Promise<void>}
         * Промис, представляющий завершение инициализации базовой директории БД.
         * Рекомендуется дождаться его выполнения перед активной работой с БД,
         * особенно если есть вероятность ошибок доступа к файловой системе.
         */
        this.baseDirInitPromise = this._initializeBaseDirectory();
    }

    /**
     * Инициализирует (создает, если необходимо) базовую директорию для хранения данных WiseJSON.
     * @private
     * @returns {Promise<void>}
     * @throws {Error} Если не удалось создать или получить доступ к базовой директории.
     */
    async _initializeBaseDirectory() {
        try {
            await fs.mkdir(this.dbRootPath, { recursive: true });
        } catch (error) {
            // Сообщение об ошибке теперь с префиксом
            const errorMessage = `WiseJSON: КРИТИЧЕСКАЯ ОШИБКА: не удалось создать/проверить базовую директорию БД "${this.dbRootPath}": ${error.message}`;
            console.error(errorMessage, error.stack);
            throw new Error(errorMessage);
        }
    }

    /**
     * Получает (или создает, если не существует) экземпляр коллекции.
     * Гарантирует, что для каждого имени коллекции существует только один экземпляр `Collection`,
     * и что процесс его инициализации выполняется только один раз, даже при конкурентных запросах.
     * 
     * @param {string} collectionName - Имя коллекции. Должно быть валидным именем для директории.
     * @param {object} [collectionOptions={}] - Опции, специфичные для этой коллекции.
     *                                          Эти опции переопределяют глобальные опции,
     *                                          заданные в конструкторе `WiseJSON`.
     * @param {number} [collectionOptions.maxSegmentSizeBytes] - Максимальный размер файла-сегмента.
     * @param {number|null} [collectionOptions.jsonIndent] - Отступ для JSON.
     * @param {function():string} [collectionOptions.idGenerator] - Генератор ID.
     * @returns {Promise<Collection>} - Промис, который разрешается экземпляром `Collection`.
     * @throws {Error} Если `collectionName` не является непустой строкой.
     */
    async collection(collectionName, collectionOptions = {}) {
        if (!collectionName || typeof collectionName !== 'string') {
            // Сообщение об ошибке теперь с префиксом
            throw new Error("WiseJSON: Имя коллекции (collectionName) должно быть непустой строкой.");
        }
        
        await this.baseDirInitPromise;

        if (this.collectionsCache.has(collectionName)) {
            const collectionInstance = this.collectionsCache.get(collectionName);
            await collectionInstance._ensureInitialized(); 
            return collectionInstance;
        }

        if (this.initializingCollections.has(collectionName)) {
            return this.initializingCollections.get(collectionName);
        }

        const initializationPromise = (async () => {
            try {
                const mergedOptions = { ...this.globalOptions, ...collectionOptions };
                const newCollection = new Collection(collectionName, this.dbRootPath, mergedOptions);
                
                this.collectionsCache.set(collectionName, newCollection);

                await newCollection._ensureInitialized(); 
                return newCollection;
            } finally {
                this.initializingCollections.delete(collectionName);
            }
        })();

        this.initializingCollections.set(collectionName, initializationPromise);
        
        return initializationPromise;
    }
}

module.exports = WiseJSON;