const { v4: uuidv4 } = require('uuid');

/**
 * Генератор уникальных идентификаторов по умолчанию.
 * @returns {string}
 */
function defaultIdGenerator() {
    return uuidv4();
}

/**
 * Проверяет, что строка не пустая.
 * @param {any} s
 * @returns {boolean}
 */
function isNonEmptyString(s) {
    return typeof s === 'string' && !!s.length;
}

/**
 * Проверяет, что объект — plain object (а не массив, не null, не функция и т.п.)
 * @param {any} obj
 * @returns {boolean}
 */
function isPlainObject(obj) {
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

/**
 * Проверяет, что передан массив объектов.
 * @param {any} arr
 * @returns {boolean}
 */
function isArrayOfObjects(arr) {
    return Array.isArray(arr) && arr.every(isPlainObject);
}

/**
 * Возвращает текущее время в ISO-строке (UTC).
 * @returns {string}
 */
function nowIsoString() {
    return new Date().toISOString();
}

/**
 * Помощник: преобразует массив документов в Map по _id.
 * @param {Array} docs
 * @returns {Map}
 */
function docsArrayToMap(docs) {
    const map = new Map();
    for (const doc of docs) {
        if (doc && doc._id) {
            map.set(doc._id, doc);
        }
    }
    return map;
}

/**
 * Batch helper — преобразует массив batch-операций WAL в массив документов.
 * @param {Array} walEntries
 * @returns {Array} docs
 */
function collectDocsFromWalBatch(walEntries) {
    const docs = [];
    for (const entry of walEntries) {
        if (entry.op === 'INSERT' && entry.doc) {
            docs.push(entry.doc);
        } else if (entry.op === 'BATCH_INSERT' && Array.isArray(entry.docs)) {
            docs.push(...entry.docs);
        }
    }
    return docs;
}

module.exports = {
    defaultIdGenerator,
    isNonEmptyString,
    isPlainObject,
    isArrayOfObjects,
    nowIsoString,
    docsArrayToMap,
    collectDocsFromWalBatch
};
