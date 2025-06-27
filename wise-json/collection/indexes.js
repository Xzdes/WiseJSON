// wise-json/collection/indexes.js

// const logger = require('../logger'); // --- УДАЛЕНО: Глобальный импорт больше не нужен.

/**
 * Управляет индексами коллекции.
 */
class IndexManager {
    /**
     * @param {string} [collectionName='unknown'] - Имя коллекции для логирования.
     * @param {object} [logger] - Экземпляр логгера. Если не передан, будет использован логгер по умолчанию.
     */
    constructor(collectionName = 'unknown', logger) {
        this.collectionName = collectionName;
        // +++ ИЗМЕНЕНИЕ: Сохраняем переданный логгер или используем фоллбэк.
        this.logger = logger || require('../logger');
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
            this.logger.error(`[IndexManager] fieldName должен быть строкой для коллекции '${this.collectionName}', получено: ${typeof fieldName} ('${fieldName}')`);
            throw new Error(`IndexManager: fieldName должен быть непустой строкой`);
        }

        if (this.indexes.has(fieldName)) {
            const existingIndex = this.indexes.get(fieldName);
            const newIsUnique = options.unique === true;
            const existingIsUnique = existingIndex.type === 'unique';

            if (newIsUnique === existingIsUnique) {
                this.logger.warn(`[IndexManager] Индекс по полю '${fieldName}' (type: ${existingIndex.type}) для коллекции '${this.collectionName}' уже существует — создание пропускается.`);
                return;
            } else {
                this.logger.error(`[IndexManager] Попытка изменить тип существующего индекса для поля '${fieldName}' в коллекции '${this.collectionName}'. Существующий: ${existingIndex.type}, Новый: ${newIsUnique ? 'unique' : 'standard'}. Удалите старый индекс перед созданием нового с другим типом.`);
                throw new Error(`IndexManager: индекс по полю '${fieldName}' уже существует с другим типом. Удалите его перед повторным созданием.`);
            }
        }

        const isUnique = options.unique === true;

        const index = {
            type: isUnique ? 'unique' : 'standard',
            data: isUnique ? new Map() : new Map(), // value -> ID или Set<ID>
            fieldName,
        };

        this.indexes.set(fieldName, index);
        this.indexedFields.add(fieldName);
        this.logger.log(`[IndexManager] Индекс по полю '${fieldName}' (type: ${index.type}) для коллекции '${this.collectionName}' успешно создан.`);
    }

    /**
     * Удаляет индекс.
     * @param {string} fieldName
     */
    dropIndex(fieldName) {
        if (!this.indexes.has(fieldName)) {
            this.logger.warn(`[IndexManager] Попытка удалить несуществующий индекс по полю '${fieldName}' для коллекции '${this.collectionName}'. Операция пропущена.`);
            return;
        }
        this.indexes.delete(fieldName);
        this.indexedFields.delete(fieldName);
        this.logger.log(`[IndexManager] Индекс по полю '${fieldName}' для коллекции '${this.collectionName}' успешно удален.`);
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
            if (!def) {
                this.logger.warn(`[IndexManager] Определение индекса для поля '${fieldName}' не найдено при перестроении в коллекции '${this.collectionName}'.`);
                continue;
            }
            def.data.clear();

            for (const [id, doc] of documents.entries()) {
                if (typeof doc !== 'object' || doc === null) continue;

                const value = doc[fieldName];

                if (def.type === 'unique') {
                    if (value !== undefined && value !== null) {
                        if (def.data.has(value)) {
                            this.logger.warn(`[IndexManager] Нарушение уникальности при перестроении индекса '${fieldName}' в коллекции '${this.collectionName}'. Значение '${value}' уже привязано к ID '${def.data.get(value)}', новый ID '${id}' будет проигнорирован для этого значения.`);
                        } else {
                            def.data.set(value, id);
                        }
                    }
                } else { // standard
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
        if (typeof doc !== 'object' || doc === null) return;
        for (const fieldName of this.indexedFields) {
            const def = this.indexes.get(fieldName);
            if (!def) continue;
            const value = doc[fieldName];

            if (def.type === 'unique') {
                if (value !== undefined && value !== null) {
                    if (def.data.has(value) && def.data.get(value) !== doc._id) {
                         this.logger.error(`[IndexManager] КРИТИЧЕСКАЯ ОШИБКА: Дубликат значения '${value}' в уникальном индексе '${fieldName}' (коллекция '${this.collectionName}') обнаружен ПОСЛЕ вставки документа ID '${doc._id}'. Этого не должно было произойти.`);
                    }
                    def.data.set(value, doc._id);
                }
            } else { // standard
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
        if (typeof doc !== 'object' || doc === null) return;
        for (const fieldName of this.indexedFields) {
            const def = this.indexes.get(fieldName);
            if (!def) continue;
            const value = doc[fieldName];

            if (def.type === 'unique') {
                if (value !== undefined && value !== null) {
                    if (def.data.get(value) === doc._id) {
                        def.data.delete(value);
                    }
                }
            } else { // standard
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
        if (typeof oldDoc !== 'object' || oldDoc === null || typeof newDoc !== 'object' || newDoc === null) return;

        for (const fieldName of this.indexedFields) {
            const def = this.indexes.get(fieldName);
            if (!def) continue;

            const oldVal = oldDoc[fieldName];
            const newVal = newDoc[fieldName];

            if (oldVal !== newVal || (newDoc.hasOwnProperty(fieldName) && oldDoc[fieldName] === undefined) || (oldDoc.hasOwnProperty(fieldName) && newDoc[fieldName] === undefined)) {
                // Удаляем старое значение из индекса
                if (def.type === 'unique') {
                    if (oldVal !== undefined && oldVal !== null) {
                        if (def.data.get(oldVal) === oldDoc._id) {
                            def.data.delete(oldVal);
                        }
                    }
                } else { // standard
                    const oldSet = def.data.get(oldVal);
                    if (oldSet) {
                        oldSet.delete(oldDoc._id);
                        if (oldSet.size === 0) def.data.delete(oldVal);
                    }
                }

                // Добавляем новое значение в индекс
                if (def.type === 'unique') {
                    if (newVal !== undefined && newVal !== null) {
                        if (def.data.has(newVal) && def.data.get(newVal) !== newDoc._id) {
                            this.logger.error(`[IndexManager] КРИТИЧЕСКАЯ ОШИБКА: Дубликат значения '${newVal}' в уникальном индексе '${fieldName}' (коллекция '${this.collectionName}') обнаружен ПОСЛЕ обновления документа ID '${newDoc._id}'.`);
                        }
                        def.data.set(newVal, newDoc._id);
                    }
                } else { // standard
                    if (newVal !== undefined || newVal === null) {
                        if (!def.data.has(newVal)) def.data.set(newVal, new Set());
                        def.data.get(newVal).add(newDoc._id);
                    }
                }
            }
        }
    }

    /**
     * Поиск по индексу (уникальному).
     * @param {string} fieldName
     * @param {any} value
     * @returns {string|null} - ID или null
     */
    findOneIdByIndex(fieldName, value) {
        const def = this.indexes.get(fieldName);
        if (!def || def.type !== 'unique') {
            return null;
        }
        return def.data.get(value) || null;
    }

    /**
     * Поиск по индексу (стандартному).
     * @param {string} fieldName
     * @param {any} value
     * @returns {Set<string>} - множество ID (может быть пустым)
     */
    findIdsByIndex(fieldName, value) {
        const def = this.indexes.get(fieldName);
        if (!def || def.type !== 'standard') {
            return new Set();
        }
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