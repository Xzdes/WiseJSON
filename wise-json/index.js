// wise-json/index.js

const path = require('path');
const Collection = require('./collection/core.js');

const DEFAULT_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');

class WiseJSON {
    constructor(dbRootPath = DEFAULT_PATH, options = {}) {
        this.dbRootPath = dbRootPath;
        this.options = options;
        this.collections = {};
    }

    async init() {
        return true;
    }

    async collection(name) {
        if (!this.collections[name]) {
            this.collections[name] = new Collection(name, this.dbRootPath, this.options);
        }
        return this.collections[name];
    }

    async getCollectionNames() {
        const fs = require('fs/promises');
        try {
            const dirs = await fs.readdir(this.dbRootPath, { withFileTypes: true });
            return dirs.filter(d => d.isDirectory()).map(d => d.name);
        } catch (e) {
            return [];
        }
    }

    // --- ДОБАВЬ ВОТ ЭТО ---
    /**
     * Закрывает все коллекции, сбрасывает на диск, останавливает таймеры.
     */
    async close() {
        const all = Object.values(this.collections);
        for (const col of all) {
            if (col && typeof col.close === 'function') {
                await col.close();
            }
        }
    }
}

module.exports = WiseJSON;
