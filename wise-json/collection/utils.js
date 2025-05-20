// collection/utils.js
const { v4: uuidv4 } = require('uuid');

/**
 * Генерирует уникальный ID (по умолчанию через uuid).
 * @returns {string}
 */
function defaultIdGenerator() {
    return uuidv4();
}

/**
 * Проверяет, что переданное значение — строка непустая.
 * @param {any} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Проверяет, что значение — объект (и не null, и не массив).
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Возвращает текущую временную метку в ISO формате.
 * @returns {string}
 */
function nowIso() {
    return new Date().toISOString();
}

/**
 * Глубокая копия объекта через JSON (для простых структур).
 * @param {any} obj
 * @returns {any}
 */
function deepCloneJson(obj) {
    return JSON.parse(JSON.stringify(obj));
}

module.exports = {
    defaultIdGenerator,
    isNonEmptyString,
    isPlainObject,
    nowIso,
    deepCloneJson,
};
