// collection/indexes.js

/**
 * Управляет индексами коллекции.
 */
class IndexManager {
    constructor(collectionName = 'unknown') {
        this.collectionName = collectionName;
        this.indexes = new Map();     // fieldName -> { type, data, fieldName }
        this.indexedFields = new Set();
    }

    /**
     * Создаёт индекс.
     * @param {string} fieldName
     * @param {{unique?: boolean}} [options]
     */
    createIndex(fieldName, options = {}) {
        if (!fieldName || typeof fieldName !== 'string') {
            throw new Error(`IndexManager: fieldName должен быть строкой`);
        }

        if (this.indexes.has(fieldName)) {
            throw new Error(`IndexManager: индекс по полю '${fieldName}' уже существует`);
        }

        const isUnique = options.unique === true;

        const index = {
            type: isUnique ? 'unique' : 'standard',
            data: isUnique ? new Map() : new Map(), // value -> ID или Set<ID>
            fieldName,
        };

        this.indexes.set(fieldName, index);
        this.indexedFields.add(fieldName);
    }

    /**
     * Удаляет индекс.
     * @param {string} fieldName
     */
    dropIndex(fieldName) {
        this.indexes.delete(fieldName);
        this.indexedFields.delete(fieldName);
    }

    /**
     * Возвращает мета-информацию об индексах.
     * @returns {Array<{fieldName: string, type: string}>}
     */
    getIndexesMeta() {
        return Array.from(this.indexes.values()).map(index => ({
            fieldName: index.fieldName,
            type: index.type,
        }));
    }

    /**
     * Восстанавливает индексы из данных.
     * @param {Map<string, object>} documents
     */
    rebuildIndexesFromData(documents) {
        for (const fieldName of this.indexedFields) {
            const def = this.indexes.get(fieldName);
            def.data.clear();

            for (const [id, doc] of documents.entries()) {
                const value = doc[fieldName];

                if (def.type === 'unique') {
                    if (value !== undefined && value !== null) {
                        if (def.data.has(value)) {
                            console.warn(`[IndexManager] Дублирующее значение '${value}' в уникальном индексе '${fieldName}' при восстановлении`);
                        }
                        def.data.set(value, id);
                    }
                } else {
                    if (!def.data.has(value)) {
                        def.data.set(value, new Set());
                    }
                    def.data.get(value).add(id);
                }
            }
        }
    }

    /**
     * Обновляет индексы после вставки.
     * @param {object} doc
     */
    afterInsert(doc) {
        for (const fieldName of this.indexedFields) {
            const def = this.indexes.get(fieldName);
            const value = doc[fieldName];

            if (def.type === 'unique') {
                if (value !== undefined && value !== null) {
                    if (def.data.has(value) && def.data.get(value) !== doc._id) {
                        throw new Error(`IndexManager: дубликат значения '${value}' в уникальном индексе '${fieldName}'`);
                    }
                    def.data.set(value, doc._id);
                }
            } else {
                if (!def.data.has(value)) def.data.set(value, new Set());
                def.data.get(value).add(doc._id);
            }
        }
    }

    /**
     * Обновляет индексы после удаления.
     * @param {object} doc
     */
    afterRemove(doc) {
        for (const fieldName of this.indexedFields) {
            const def = this.indexes.get(fieldName);
            const value = doc[fieldName];

            if (def.type === 'unique') {
                if (def.data.get(value) === doc._id) {
                    def.data.delete(value);
                }
            } else {
                const set = def.data.get(value);
                if (set) {
                    set.delete(doc._id);
                    if (set.size === 0) def.data.delete(value);
                }
            }
        }
    }

    /**
     * Обновляет индексы после обновления.
     * @param {object} oldDoc
     * @param {object} newDoc
     */
    afterUpdate(oldDoc, newDoc) {
        for (const fieldName of this.indexedFields) {
            const def = this.indexes.get(fieldName);
            const oldVal = oldDoc[fieldName];
            const newVal = newDoc[fieldName];

            const changed = oldVal !== newVal;

            if (!changed) continue;

            if (def.type === 'unique') {
                if (def.data.get(oldVal) === oldDoc._id) {
                    def.data.delete(oldVal);
                }

                if (def.data.has(newVal) && def.data.get(newVal) !== newDoc._id) {
                    throw new Error(`IndexManager: дубликат значения '${newVal}' в уникальном индексе '${fieldName}'`);
                }

                def.data.set(newVal, newDoc._id);
            } else {
                const oldSet = def.data.get(oldVal);
                if (oldSet) {
                    oldSet.delete(oldDoc._id);
                    if (oldSet.size === 0) def.data.delete(oldVal);
                }

                if (!def.data.has(newVal)) def.data.set(newVal, new Set());
                def.data.get(newVal).add(newDoc._id);
            }
        }
    }

    /**
     * Поиск по индексу (уникальному).
     * @param {string} fieldName
     * @param {any} value
     * @returns {string|null} - ID
     */
    findOneIdByIndex(fieldName, value) {
        const def = this.indexes.get(fieldName);
        if (!def || def.type !== 'unique') return null;
        return def.data.get(value) || null;
    }

    /**
     * Поиск по индексу (стандартному).
     * @param {string} fieldName
     * @param {any} value
     * @returns {Set<string>} - множество ID
     */
    findIdsByIndex(fieldName, value) {
        const def = this.indexes.get(fieldName);
        if (!def || def.type !== 'standard') return new Set();
        return def.data.get(value) || new Set();
    }

    /**
     * Очистка всех данных индексов.
     */
    clearAllData() {
        for (const def of this.indexes.values()) {
            def.data.clear();
        }
    }
}

module.exports = IndexManager;
