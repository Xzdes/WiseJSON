// wise-json/index.js

const path = require('path');
const Collection = require('./collection/core.js');
const TransactionManager = require('./collection/transaction-manager.js');
const { makeAbsolutePath, validateOptions } = require('./collection/utils.js');
const logger = require('./logger');

const DEFAULT_PATH = process.env.WISE_JSON_PATH || makeAbsolutePath('wise-json-db-data');

/**
 * Основной класс для управления базой данных WiseJSON.
 * Является точкой входа для работы с коллекциями и транзакциями.
 */
class WiseJSON {
    /**
     * Создает экземпляр базы данных.
     * @param {string} [dbRootPath=./wise-json-db-data] - Путь к корневой директории, где будут храниться все данные.
     * @param {object} [options={}] - Объект с опциями конфигурации для базы данных.
     */
    constructor(dbRootPath = DEFAULT_PATH, options = {}) {
        this.dbRootPath = makeAbsolutePath(dbRootPath);
        this.options = validateOptions(options);
        this.collections = {}; // Кэш для экземпляров коллекций
        this._activeTransactions = [];

        // Устанавливаем обработчик корректного завершения только один раз
        if (!WiseJSON._hasGracefulShutdown) {
            this._setupGracefulShutdown();
            WiseJSON._hasGracefulShutdown = true;
        }
    }

    /**
     * Асинхронно инициализирует базу данных. В текущей реализации просто возвращает true,
     * но зарезервирован для возможного расширения в будущем.
     * @returns {Promise<boolean>}
     */
    async init() {
        // Здесь может быть логика проверки директории, прав доступа и т.д.
        return true;
    }

    /**
     * Синхронно получает или создает экземпляр коллекции, но не дожидается ее инициализации.
     * Для большинства случаев используйте асинхронный метод `getCollection`.
     * @param {string} name - Имя коллекции.
     * @returns {Promise<Collection>} Промис, который разрешается экземпляром коллекции.
     */
    async collection(name) {
        if (!this.collections[name]) {
            this.collections[name] = new Collection(name, this.dbRootPath, this.options);
        }
        return this.collections[name];
    }

    /**
     * Асинхронно получает или создает коллекцию и дожидается ее полной инициализации.
     * Это рекомендуемый способ получения коллекции для работы.
     * @param {string} name - Имя коллекции.
     * @returns {Promise<Collection>} Готовый к работе экземпляр коллекции.
     */
    async getCollection(name) {
        const collectionInstance = await this.collection(name);
        // Дожидаемся, пока коллекция загрузит данные с диска (чекпоинт и WAL)
        await collectionInstance.initPromise;
        return collectionInstance;
    }

    /**
     * Возвращает имена всех существующих коллекций в базе данных.
     * Сканирует директорию БД и возвращает имена подпапок.
     * @returns {Promise<string[]>} Массив с именами коллекций.
     */
    async getCollectionNames() {
        const fs = require('fs/promises');
        try {
            const dirs = await fs.readdir(this.dbRootPath, { withFileTypes: true });
            return dirs
                .filter(
                    d =>
                        d.isDirectory() &&
                        !d.name.startsWith('.') && // Игнорируем скрытые папки
                        d.name !== '_checkpoints' && // Игнорируем служебную папку чекпоинтов
                        d.name !== 'node_modules'
                )
                .map(d => d.name);
        } catch (e) {
            // Если директория БД не существует, возвращаем пустой массив
            if (e.code === 'ENOENT') {
                return [];
            }
            // Другие ошибки пробрасываем
            throw e;
        }
    }

    /**
     * Корректно закрывает все открытые коллекции, сохраняя все несохраненные данные на диск.
     * Этот метод крайне важно вызывать перед завершением работы приложения.
     * @returns {Promise<void>}
     */
    async close() {
        const allCollections = Object.values(this.collections);
        for (const col of allCollections) {
            if (col && typeof col.close === 'function') {
                await col.close();
            }
        }
    }

    /**
     * Устанавливает обработчики системных сигналов для корректного завершения
     * и сохранения данных (graceful shutdown).
     * @private
     */
    _setupGracefulShutdown() {
        const signals = ['SIGINT', 'SIGTERM'];
        let isShuttingDown = false;
        signals.forEach(signal => {
            process.on(signal, async () => {
                if (isShuttingDown) return;
                isShuttingDown = true;
                try {
                    logger.log(`\n[WiseJSON] Received ${signal} signal, saving all collections...`);
                    // 'this' в данном контексте будет указывать на первый созданный экземпляр WiseJSON.
                    // Для мульти-инстанс окружения это может потребовать доработки.
                    await this.close();
                    logger.log('[WiseJSON] All data saved. Shutting down.');
                } catch (e) {
                    logger.error('[WiseJSON] Error during graceful shutdown:', e);
                } finally {
                    process.exit(0);
                }
            });
        });
    }

    /**
     * Начинает новую транзакцию, которая может затрагивать несколько коллекций.
     * @returns {TransactionManager} Объект менеджера транзакций.
     */
    beginTransaction() {
        const txn = new TransactionManager(this);
        this._activeTransactions.push(txn);
        return txn;
    }

    /**
     * Возвращает массив активных (незавершенных) транзакций.
     * @returns {TransactionManager[]}
     */
    getActiveTransactions() {
        return this._activeTransactions.filter(txn => txn.state === 'pending');
    }
}

module.exports = WiseJSON;