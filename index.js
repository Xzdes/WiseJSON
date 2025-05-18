// wise-json/index.js
const fs = require('fs/promises');
const path = require('path');
const Collection = require('./collection');

/**
 * Класс WiseJSON предоставляет точку входа для работы с базой данных,
 * управляющей набором коллекций.
 */
class WiseJSON {
    /**
     * Создает экземпляр WiseJSON.
     * @param {string} dbRootPath - Корневой путь к директории, где будут храниться данные базы.
     * @param {object} [globalOptions={}] - Глобальные опции, применяемые ко всем коллекциям по умолчанию.
     * @param {number} [globalOptions.maxSegmentSizeBytes] - Глобальный макс. размер сегмента.
     * @param {number | null} [globalOptions.jsonIndent] - Глобальный отступ для JSON.
     */
    constructor(dbRootPath, globalOptions = {}) {
        if (!dbRootPath || typeof dbRootPath !== 'string') {
            throw new Error("WiseJSON: Корневой путь к базе данных (dbRootPath) должен быть непустой строкой.");
        }
        this.dbRootPath = path.resolve(dbRootPath); // Нормализуем путь
        this.globalOptions = globalOptions;
        this.collectionsCache = new Map(); // Кэш для экземпляров Collection
        this.baseDirInitPromise = this._initializeBaseDirectory(); // Промис инициализации базовой директории
    }

    /**
     * Асинхронно инициализирует (создает, если необходимо) базовую директорию БД.
     * @private
     */
    async _initializeBaseDirectory() {
        try {
            await fs.mkdir(this.dbRootPath, { recursive: true });
        } catch (error) {
            const errorMessage = `WiseJSON: КРИТИЧЕСКАЯ ОШИБКА: не удалось создать/проверить базовую директорию БД "${this.dbRootPath}": ${error.message}`;
            console.error(errorMessage, error.stack);
            throw new Error(errorMessage); // Перебрасываем, чтобы приложение знало о критическом сбое
        }
    }

    /**
     * Получает или создает экземпляр коллекции.
     * @param {string} collectionName - Имя запрашиваемой коллекции.
     * @param {object} [collectionOptions={}] - Опции, специфичные для этой коллекции.
     *                                        Переопределяют глобальные опции.
     * @returns {Promise<Collection>} Промис, который разрешается экземпляром Collection.
     */
    async collection(collectionName, collectionOptions = {}) {
        if (!collectionName || typeof collectionName !== 'string') {
            throw new Error("WiseJSON: Имя коллекции (collectionName) должно быть непустой строкой.");
        }

        // Гарантируем, что базовая директория БД готова перед работой с коллекциями
        await this.baseDirInitPromise;

        if (this.collectionsCache.has(collectionName)) {
            const collectionInstance = this.collectionsCache.get(collectionName);
            // Убеждаемся, что сама коллекция инициализирована (на случай, если промис initPromise еще не разрешился)
            await collectionInstance._ensureInitialized();
            return collectionInstance;
        }

        // Объединяем глобальные опции с опциями для конкретной коллекции
        // Опции коллекции имеют приоритет
        const mergedOptions = { ...this.globalOptions, ...collectionOptions };

        const newCollection = new Collection(collectionName, this.dbRootPath, mergedOptions);
        this.collectionsCache.set(collectionName, newCollection);

        // Ждем завершения инициализации новой коллекции перед тем, как ее вернуть
        await newCollection._ensureInitialized();
        return newCollection;
    }
}

module.exports = WiseJSON;