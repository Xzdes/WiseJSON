// index.js

const fs = require('fs/promises');
const path = require('path');
const Collection = require('./collection/core.js');

/**
 * @class WiseJSON
 * @description Менеджер для коллекций и базы данных WiseJSON.
 */
class WiseJSON {
    /**
     * @param {string} dbRootPath — корневая папка БД
     * @param {object} [globalOptions={}] — глобальные опции для всех коллекций
     */
    constructor(dbRootPath, globalOptions = {}) {
        if (!dbRootPath || typeof dbRootPath !== 'string') {
            throw new Error('WiseJSON: dbRootPath должен быть непустой строкой');
        }

        this.dbRootPath = path.resolve(process.cwd(), dbRootPath);
        this.globalOptions = globalOptions;

        this.collectionsCache = new Map();
        this.initializingCollections = new Map();
        this.baseDirInitPromise = this._ensureBaseDir();
    }

    async _ensureBaseDir() {
        try {
            await fs.mkdir(this.dbRootPath, { recursive: true });
        } catch (err) {
            console.error(`[WiseJSON] ❌ Не удалось создать директорию базы: ${err.message}`);
            throw err;
        }
    }

    /**
     * Получает или создаёт коллекцию.
     * @param {string} collectionName
     * @param {object} [collectionOptions={}]
     * @returns {Promise<Collection>}
     */
    async collection(collectionName, collectionOptions = {}) {
        if (!collectionName || typeof collectionName !== 'string') {
            throw new Error('WiseJSON: collectionName должен быть непустой строкой');
        }

        await this.baseDirInitPromise;

        if (this.collectionsCache.has(collectionName)) {
            const col = this.collectionsCache.get(collectionName);
            await col.initPromise;
            return col;
        }

        if (this.initializingCollections.has(collectionName)) {
            return this.initializingCollections.get(collectionName);
        }

        const initPromise = (async () => {
            const mergedOptions = { ...this.globalOptions, ...collectionOptions };
            const collection = new Collection(collectionName, this.dbRootPath, mergedOptions);
            this.collectionsCache.set(collectionName, collection);

            try {
                await collection.initPromise;
                return collection;
            } catch (err) {
                this.collectionsCache.delete(collectionName);
                throw err;
            } finally {
                this.initializingCollections.delete(collectionName);
            }
        })();

        this.initializingCollections.set(collectionName, initPromise);
        return initPromise;
    }

    /**
     * Закрывает все коллекции, делая финальный чекпоинт.
     * @returns {Promise<void>}
     */
    async close() {
        console.log('[WiseJSON] Закрытие базы данных...');
        const pending = Array.from(this.initializingCollections.values());

        if (pending.length > 0) {
            await Promise.allSettled(pending);
        }

        const closing = [];
        for (const collection of this.collectionsCache.values()) {
            closing.push(collection.close().catch(e =>
                console.warn(`[WiseJSON] ⚠ Ошибка при закрытии коллекции: ${e.message}`)
            ));
        }

        await Promise.allSettled(closing);
        console.log('[WiseJSON] ✅ Все коллекции закрыты.');
    }
}

module.exports = WiseJSON;
