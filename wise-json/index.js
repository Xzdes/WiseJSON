// wise-json/index.js
const fs = require('fs/promises');
const path = require('path');
const Collection = require('./collection.js'); // Подключаем нашу новую, переписанную Collection

/**
 * @class WiseJSON
 * @classdesc Основной класс для управления базой данных WiseJSON.
 * Предоставляет доступ к коллекциям данных, работающим по принципу In-Memory First с WAL и Checkpoints.
 */
class WiseJSON {
    /**
     * Создает экземпляр WiseJSON.
     * @param {string} dbRootPath - Корневой путь к директории, где будут храниться данные базы.
     *                               Эта директория будет создана, если не существует.
     * @param {object} [globalOptions={}] - Глобальные опции, применяемые ко всем коллекциям по умолчанию.
     * @param {number|null} [globalOptions.jsonIndent=2] - Отступ для форматирования JSON-файлов чекпоинтов.
     * @param {function():string} [globalOptions.idGenerator] - Функция для генерации уникальных ID документов (по умолчанию uuidv4).
     * @param {number} [globalOptions.maxSegmentSizeBytes] - Максимальный размер одного сегмента данных внутри файла чекпоинта.
     * @param {number} [globalOptions.checkpointIntervalMs=300000] - Интервал автоматических чекпоинтов в миллисекундах (0 для отключения).
     * @param {number} [globalOptions.maxWalEntriesBeforeCheckpoint=1000] - Максимальное количество записей в WAL до запуска автоматического чекпоинта (0 для отключения).
     * @param {boolean} [globalOptions.walForceSync=false] - Форсировать вызов fsync после каждой записи в WAL для максимальной надежности (снижает производительность).
     * @param {number} [globalOptions.checkpointsToKeep=2] - Количество последних чекпоинтов, которые нужно хранить (минимум 1).
     * @throws {Error} Если `dbRootPath` не является непустой строкой.
     */
    constructor(dbRootPath, globalOptions = {}) {
        if (!dbRootPath || typeof dbRootPath !== 'string') {
            throw new Error("WiseJSON: Корневой путь к базе данных (dbRootPath) должен быть непустой строкой.");
        }
        this.dbRootPath = path.resolve(dbRootPath);
        this.globalOptions = { ...globalOptions }; // Копируем опции

        this.collectionsCache = new Map();
        this.initializingCollections = new Map(); // Для отслеживания промисов инициализации коллекций
        this.baseDirInitPromise = this._initializeBaseDirectory();
    }

    /**
     * Инициализирует (создает, если необходимо) базовую директорию для хранения данных WiseJSON.
     * @private
     * @returns {Promise<void>}
     */
    async _initializeBaseDirectory() {
        try {
            await fs.mkdir(this.dbRootPath, { recursive: true });
        } catch (error) {
            const errorMessage = `WiseJSON: КРИТИЧЕСКАЯ ОШИБКА: не удалось создать/проверить базовую директорию БД "${this.dbRootPath}": ${error.message}`;
            console.error(errorMessage, error.stack);
            throw new Error(errorMessage);
        }
    }

    /**
     * Получает (или создает, если не существует) экземпляр коллекции.
     * @param {string} collectionName - Имя коллекции.
     * @param {object} [collectionOptions={}] - Опции, специфичные для этой коллекции (переопределяют глобальные).
     *                                          См. конструктор WiseJSON для списка возможных опций.
     * @returns {Promise<Collection>} - Промис, который разрешается экземпляром `Collection`.
     * @throws {Error} Если `collectionName` не является непустой строкой.
     */
    async collection(collectionName, collectionOptions = {}) {
        if (!collectionName || typeof collectionName !== 'string') {
            throw new Error("WiseJSON: Имя коллекции (collectionName) должен быть непустой строкой.");
        }
        
        // Убеждаемся, что базовая директория готова
        await this.baseDirInitPromise;

        // 1. Проверка, есть ли уже полностью инициализированный экземпляр в кеше
        if (this.collectionsCache.has(collectionName)) {
            const collectionInstance = this.collectionsCache.get(collectionName);
            // _ensureInitialized() теперь вызывается внутри методов коллекции при необходимости,
            // но мы все равно ждем initPromise здесь, чтобы убедиться, что коллекция готова к работе.
            await collectionInstance.initPromise; 
            return collectionInstance;
        }

        // 2. Проверка, не инициализируется ли эта коллекция прямо сейчас другим вызовом
        if (this.initializingCollections.has(collectionName)) {
            return this.initializingCollections.get(collectionName);
        }

        // 3. Это первый запрос на эту коллекцию, начинаем процесс инициализации
        const initializationPromise = (async () => {
            let newCollection;
            try {
                const mergedOptions = { ...this.globalOptions, ...collectionOptions };
                newCollection = new Collection(collectionName, this.dbRootPath, mergedOptions);
                
                // Помещаем сам экземпляр в основной кеш ДО того, как начнем ждать его initPromise.
                this.collectionsCache.set(collectionName, newCollection);

                await newCollection.initPromise; // Ждем завершения внутреннего initPromise коллекции
                return newCollection;
            } catch (error) {
                // Если инициализация коллекции не удалась, удаляем ее из кеша,
                // чтобы при следующем запросе была предпринята новая попытка инициализации.
                // Также удаляем из initializingCollections, если она там еще есть (хотя finally ниже это сделает).
                if (newCollection) { // Если экземпляр был создан до ошибки
                    this.collectionsCache.delete(collectionName);
                }
                // Ошибка уже должна быть залогирована внутри Collection или ее зависимостей
                throw error; // Перебрасываем ошибку, чтобы вызывающий код мог ее обработать.
            }
            finally {
                // После завершения инициализации (успешной или с ошибкой),
                // удаляем промис из карты initializingCollections.
                this.initializingCollections.delete(collectionName);
            }
        })();

        // Сохраняем этот промис в карту initializingCollections
        this.initializingCollections.set(collectionName, initializationPromise);
        
        return initializationPromise;
    }

    /**
     * Закрывает все активные коллекции и базу данных.
     * Выполняет финальные чекпоинты для всех коллекций.
     * Это асинхронная операция. Рекомендуется вызывать перед завершением приложения.
     * @returns {Promise<void>} Промис, который разрешается, когда все коллекции закрыты.
     */
    async close() {
        console.log("WiseJSON: Начало закрытия базы данных...");
        
        // Сначала дожидаемся завершения всех текущих инициализаций
        const pendingInitializations = Array.from(this.initializingCollections.values());
        if (pendingInitializations.length > 0) {
            console.log(`WiseJSON: Ожидание завершения ${pendingInitializations.length} инициализаций коллекций...`);
            await Promise.allSettled(pendingInitializations).then(results => {
                results.forEach(result => {
                    if (result.status === 'rejected') {
                        console.warn(`WiseJSON: Ошибка при ожидании инициализации коллекции во время закрытия: ${result.reason.message}`);
                    }
                });
            });
        }
        
        const closePromises = [];
        if (this.collectionsCache.size > 0) {
            console.log(`WiseJSON: Закрытие ${this.collectionsCache.size} активных коллекций...`);
            for (const [name, collectionInstance] of this.collectionsCache) {
                // Убедимся, что коллекция действительно была инициализирована перед закрытием,
                // или ее initPromise завершился (даже с ошибкой).
                // Метод close коллекции сам должен быть устойчив к вызову на не до конца инициализированном объекте,
                // но лучше дождаться initPromise.
                const closeOp = (async () => {
                    try {
                        if (collectionInstance.initPromise) { // Если initPromise существует
                           await collectionInstance.initPromise.catch(() => { /* Ошибки инициализации уже обработаны/залогированы */ });
                        }
                        // Вызываем close, даже если инициализация упала, чтобы попытаться освободить ресурсы (таймеры)
                        await collectionInstance.close(); 
                        console.log(`WiseJSON: Коллекция "${name}" закрыта.`);
                    } catch (err) {
                        console.error(`WiseJSON: Ошибка при закрытии коллекции "${name}": ${err.message}`);
                        // Не прерываем закрытие других коллекций
                    }
                })();
                closePromises.push(closeOp);
            }
    
            await Promise.allSettled(closePromises); 
        } else {
            console.log("WiseJSON: Нет активных коллекций для закрытия.");
        }

        this.collectionsCache.clear();
        this.initializingCollections.clear(); // Должна быть уже пуста после finally в collection()
        
        // Базовую директорию и ее промис не трогаем, т.к. БД может быть вновь открыта.
        console.log("WiseJSON: База данных успешно закрыта.");
    }
}

module.exports = WiseJSON;