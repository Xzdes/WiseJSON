// wise-json/index.js
const fs = require('fs/promises');
const path = require('path');
const Collection = require('./collection');
// const { v4: uuidv4 } = require('uuid'); // uuidv4 теперь используется как дефолт в Collection

class WiseJSON {
    constructor(dbRootPath, globalOptions = {}) {
        if (!dbRootPath || typeof dbRootPath !== 'string') {
            throw new Error("WiseJSON: Корневой путь к базе данных (dbRootPath) должен быть непустой строкой.");
        }
        this.dbRootPath = path.resolve(dbRootPath);
        this.globalOptions = {
            // Здесь можно задать дефолтный idGenerator, если не хотим uuidv4,
            // но Collection уже имеет uuidv4 как свой внутренний дефолт.
            // Если мы хотим переопределить дефолт на уровне WiseJSON, то так:
            // idGenerator: () => uuidv4(), // Пример
            ...globalOptions // Пользовательские глобальные опции переопределят наши дефолты
        };
        this.collectionsCache = new Map();
        this.baseDirInitPromise = this._initializeBaseDirectory();
    }

    async _initializeBaseDirectory() {
        try {
            await fs.mkdir(this.dbRootPath, { recursive: true });
        } catch (error) {
            const errorMessage = `WiseJSON: КРИТИЧЕСКАЯ ОШИБКА: не удалось создать/проверить базовую директорию БД "${this.dbRootPath}": ${error.message}`;
            console.error(errorMessage, error.stack);
            throw new Error(errorMessage);
        }
    }

    async collection(collectionName, collectionOptions = {}) {
        if (!collectionName || typeof collectionName !== 'string') {
            throw new Error("WiseJSON: Имя коллекции (collectionName) должно быть непустой строкой.");
        }
        await this.baseDirInitPromise;

        if (this.collectionsCache.has(collectionName)) {
            const collectionInstance = this.collectionsCache.get(collectionName);
            await collectionInstance._ensureInitialized();
            return collectionInstance;
        }

        // Опции коллекции имеют приоритет над глобальными
        const mergedOptions = { ...this.globalOptions, ...collectionOptions };

        const newCollection = new Collection(collectionName, this.dbRootPath, mergedOptions);
        this.collectionsCache.set(collectionName, newCollection);
        await newCollection._ensureInitialized();
        return newCollection;
    }
}

module.exports = WiseJSON;