// wise-json/index.js

const path = require('path');
const fs = require('fs/promises');
const Collection = require('./collection/core.js');
const TransactionManager = require('./collection/transaction-manager.js');
const { makeAbsolutePath, validateOptions } = require('./collection/utils.js');
const logger = require('./logger');
const { ConfigurationError } = require('./errors.js');

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

        this._isInitialized = false;
        this._initPromise = null;

        if (!WiseJSON._hasGracefulShutdown) {
            this._setupGracefulShutdown();
            WiseJSON._hasGracefulShutdown = true;
        }
    }

    /**
     * Асинхронно и потокобезопасно инициализирует базу данных.
     * Если вызов init() уже в процессе, новый вызов вернет тот же самый промис.
     * Если БД уже инициализирована, промис разрешится немедленно.
     * @returns {Promise<void>}
     */
    init() {
        if (this._initPromise) {
            return this._initPromise;
        }

        this._initPromise = (async () => {
            try {
                await fs.mkdir(this.dbRootPath, { recursive: true });
                this._isInitialized = true;
                logger.log(`[WiseJSON] Database at ${this.dbRootPath} initialized.`);
            } catch (err) {
                logger.error(`[WiseJSON] Critical error during database initialization at ${this.dbRootPath}:`, err);
                this._initPromise = null;
                throw err;
            }
        })();

        return this._initPromise;
    }

    /**
     * Внутренний метод для гарантии, что БД инициализирована перед операцией.
     * @private
     */
    async _ensureInitialized() {
        if (!this._isInitialized) {
            await this.init();
        }
    }

    /**
     * Получает или создает экземпляр коллекции, но не дожидается ее полной инициализации.
     * @param {string} name - Имя коллекции.
     * @returns {Promise<Collection>} Промис, который разрешается экземпляром коллекции.
     */
    async collection(name) {
        await this._ensureInitialized();
        if (!this.collections[name]) {
            this.collections[name] = new Collection(name, this.dbRootPath, this.options);
        }
        return this.collections[name];
    }

    /**
     * Асинхронно получает или создает коллекцию и дожидается ее полной инициализации.
     * @param {string} name - Имя коллекции.
     * @returns {Promise<Collection>} Готовый к работе экземпляр коллекции.
     */
    async getCollection(name) {
        const collectionInstance = await this.collection(name);
        await collectionInstance.initPromise;
        return collectionInstance;
    }

    /**
     * Возвращает имена всех существующих коллекций в базе данных.
     * @returns {Promise<string[]>} Массив с именами коллекций.
     */
    async getCollectionNames() {
        await this._ensureInitialized();
        try {
            const items = await fs.readdir(this.dbRootPath, { withFileTypes: true });
            return items
                .filter(item =>
                    item.isDirectory() &&
                    !item.name.startsWith('.') &&       // Игнорируем скрытые папки (например, .DS_Store)
                    !item.name.endsWith('.lock') &&     // +++ ИСПРАВЛЕНИЕ: Игнорируем lock-директории
                    item.name !== '_checkpoints' &&     // Игнорируем общую папку чекпоинтов, если она есть
                    item.name !== 'node_modules'        // На всякий случай
                )
                .map(item => item.name);
        } catch (e) {
            if (e.code === 'ENOENT') {
                return [];
            }
            throw e;
        }
    }

    /**
     * Корректно закрывает все открытые коллекции, сохраняя все несохраненные данные на диск.
     * @returns {Promise<void>}
     */
    async close() {
        // Дожидаемся завершения инициализации, если она еще идет, перед закрытием
        if (this._initPromise) {
            await this._initPromise;
        }
        const allCollections = Object.values(this.collections);
        for (const col of allCollections) {
            if (col && typeof col.close === 'function') {
                await col.close();
            }
        }
    }

    /**
     * Устанавливает обработчики системных сигналов для корректного завершения.
     * @private
     */
    _setupGracefulShutdown() {
        const signals = ['SIGINT', 'SIGTERM'];
        let isShuttingDown = false;
        const shutdownHandler = async () => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            try {
                logger.log(`\n[WiseJSON] Graceful shutdown initiated, saving all collections...`);
                await this.close();
                logger.log('[WiseJSON] All data saved. Shutting down.');
            } catch (e) {
                logger.error('[WiseJSON] Error during graceful shutdown:', e);
            } finally {
                // Даем логам время записаться и выходим
                setTimeout(() => process.exit(0), 100);
            }
        };
        signals.forEach(signal => {
            process.on(signal, shutdownHandler);
        });
    }

    /**
     * Начинает новую транзакцию, которая может затрагивать несколько коллекций.
     * @returns {TransactionManager} Объект менеджера транзакций.
     * @throws {ConfigurationError} если база данных еще не инициализирована.
     */
    beginTransaction() {
        if (!this._isInitialized) {
            throw new ConfigurationError("Cannot begin transaction: database is not initialized. Call db.init() or an async method like getCollection() first.");
        }
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