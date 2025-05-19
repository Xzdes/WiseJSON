// wise-json/index.js
const fs = require('fs/promises');
const path = require('path');
const Collection = require('./collection');

class WiseJSON {
    /**
     * Создает экземпляр WiseJSON.
     * @param {string} dbRootPath - Корневой путь к директории, где будут храниться данные базы.
     * @param {object} [globalOptions={}] - Глобальные опции для всех коллекций.
     * @param {number} [globalOptions.maxSegmentSizeBytes] - Максимальный размер файла-сегмента в байтах.
     * @param {number|null} [globalOptions.jsonIndent] - Отступ для форматирования JSON (например, 2) или null/0 для компактного вывода.
     * @param {function():string} [globalOptions.idGenerator] - Функция для генерации уникальных ID документов.
     */
    constructor(dbRootPath, globalOptions = {}) {
        if (!dbRootPath || typeof dbRootPath !== 'string') {
            throw new Error("WiseJSON: Корневой путь к базе данных (dbRootPath) должен быть непустой строкой.");
        }
        this.dbRootPath = path.resolve(dbRootPath);
        this.globalOptions = {
            ...globalOptions 
        };
        this.collectionsCache = new Map();
        // Карта для хранения промисов инициализации коллекций, которые создаются в данный момент.
        // Ключ: имя коллекции (string), Значение: Promise<Collection>
        this.initializingCollections = new Map();
        this.baseDirInitPromise = this._initializeBaseDirectory();
    }

    /**
     * Инициализирует базовую директорию для хранения данных.
     * @private
     * @returns {Promise<void>}
     */
    async _initializeBaseDirectory() {
        try {
            await fs.mkdir(this.dbRootPath, { recursive: true });
        } catch (error) {
            const errorMessage = `WiseJSON: КРИТИЧЕСКАЯ ОШИБКА: не удалось создать/проверить базовую директорию БД "${this.dbRootPath}": ${error.message}`;
            console.error(errorMessage, error.stack);
            // Эта ошибка критична, так как без базовой директории работа невозможна.
            // Приложение, использующее WiseJSON, должно обработать ошибку из db.baseDirInitPromise.
            throw new Error(errorMessage);
        }
    }

    /**
     * Получает (или создает, если не существует) экземпляр коллекции.
     * Гарантирует, что для каждого имени коллекции существует только один экземпляр Collection
     * и что процесс его инициализации выполняется только один раз, даже при конкурентных запросах.
     * @param {string} collectionName - Имя коллекции.
     * @param {object} [collectionOptions={}] - Опции, специфичные для этой коллекции (переопределяют глобальные).
     * @returns {Promise<Collection>} - Промис, который разрешается экземпляром Collection.
     */
    async collection(collectionName, collectionOptions = {}) {
        if (!collectionName || typeof collectionName !== 'string') {
            // Бросаем ошибку синхронно, так как это неверное использование API
            throw new Error("WiseJSON: Имя коллекции (collectionName) должно быть непустой строкой.");
        }
        
        // Убеждаемся, что базовая директория готова (или ошибка ее создания обработана)
        await this.baseDirInitPromise;

        // 1. Проверка, есть ли уже полностью инициализированный экземпляр в кеше
        if (this.collectionsCache.has(collectionName)) {
            const collectionInstance = this.collectionsCache.get(collectionName);
            // _ensureInitialized просто ждет завершения initPromise этого экземпляра, если он еще не завершен
            await collectionInstance._ensureInitialized(); 
            return collectionInstance;
        }

        // 2. Проверка, не инициализируется ли эта коллекция прямо сейчас другим вызовом
        if (this.initializingCollections.has(collectionName)) {
            // Если да, возвращаем существующий промис инициализации
            return this.initializingCollections.get(collectionName);
        }

        // 3. Это первый запрос на эту коллекцию, начинаем процесс инициализации
        // Создаем промис, который выполнит всю работу по созданию и инициализации
        const initializationPromise = (async () => {
            try {
                const mergedOptions = { ...this.globalOptions, ...collectionOptions };
                const newCollection = new Collection(collectionName, this.dbRootPath, mergedOptions);
                
                // Важно: Помещаем сам экземпляр (не промис) в основной кеш ДО того, как начнем ждать его _ensureInitialized.
                // Это нужно, чтобы последующие быстрые вызовы db.collection() для того же имени
                // нашли экземпляр в collectionsCache (пункт 1) и вызвали его _ensureInitialized(),
                // который будет ждать тот же самый newCollection.initPromise.
                this.collectionsCache.set(collectionName, newCollection);

                await newCollection._ensureInitialized(); // Ждем завершения внутреннего initPromise коллекции
                return newCollection;
            } finally {
                // После завершения инициализации (успешной или с ошибкой),
                // удаляем промис из карты initializingCollections.
                this.initializingCollections.delete(collectionName);
            }
        })();

        // Сохраняем этот промис в карту initializingCollections
        this.initializingCollections.set(collectionName, initializationPromise);
        
        return initializationPromise;
    }
}

module.exports = WiseJSON;