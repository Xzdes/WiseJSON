/**
 * wise-json/collection/utils.js
 * Утилиты для работы с коллекциями WiseJSON (id, типы, сериализация и др.)
 */

/**
 * Генерирует уникальный id (короткий, простой).
 * @returns {string}
 */
function defaultIdGenerator() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Проверяет, является ли значение непустой строкой.
 * @param {any} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}

/**
 * Проверяет, является ли значение plain-объектом (без прототипа).
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Делает абсолютный путь (удобно для базы)
 * @param {string} p
 * @returns {string}
 */
function makeAbsolutePath(p) {
    return require('path').isAbsolute(p) ? p : require('path').resolve(process.cwd(), p);
}

/**
 * Валидирует/дополняет опции коллекции.
 * @param {object} [opts]
 * @returns {object}
 */
function validateOptions(opts = {}) {
    return Object.assign({
        maxSegmentSizeBytes: 2 * 1024 * 1024,
        checkpointIntervalMs: 60000,
        ttlCleanupIntervalMs: 60000,
        walSync: false
    }, opts || {});
}

/**
 * Преобразует массив документов в CSV-строку.
 * @param {Array<Object>} docs
 * @returns {string}
 */
function flattenDocToCsv(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return '';
    const fields = Array.from(new Set(docs.flatMap(doc => Object.keys(doc))));
    const escape = v => (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n')))
        ? `"${String(v).replace(/"/g, '""')}"`
        : v;
    const csv = [
        fields.join(','),
        ...docs.map(doc => fields.map(f => escape(doc[f] ?? '')).join(','))
    ];
    return csv.join('\n');
}

module.exports = {
    defaultIdGenerator,
    isNonEmptyString,
    isPlainObject,
    makeAbsolutePath,
    validateOptions,
    flattenDocToCsv
};
