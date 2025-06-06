/**
 * explorer/utils.js
 * Вспомогательные утилиты для WiseJSON Data Explorer
 */

const ansi = {
    reset: '\x1b[0m',
    key: '\x1b[34m',       // Синий для ключей
    string: '\x1b[32m',    // Зелёный для строк
    number: '\x1b[33m',    // Жёлтый для чисел
    boolean: '\x1b[35m',   // Фиолетовый для true/false
    null: '\x1b[90m',      // Серый для null
};

/**
 * Подсветка JSON для CLI.
 * @param {string} jsonString
 * @returns {string}
 */
function colorizeJson(jsonString) {
    return jsonString
        .replace(/"([^"]+)":/g, `"${ansi.key}$1${ansi.reset}":`)
        .replace(/"([^"]*)"/g, (match, p1) => {
            if (match.endsWith('":')) return match;
            return `"${ansi.string}${p1}${ansi.reset}"`;
        })
        .replace(/\b(-?\d+(\.\d+)?)\b/g, `${ansi.number}$1${ansi.reset}`)
        .replace(/\b(true|false)\b/g, `${ansi.boolean}$1${ansi.reset}`)
        .replace(/\b(null)\b/g, `${ansi.null}$1${ansi.reset}`);
}

/**
 * Экранирование HTML.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Преобразует JSON документы в CSV-строку.
 * @param {Array} docs
 * @returns {string}
 */
function flattenDocToCsv(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return '';
    const fields = getAllKeys(docs);
    const lines = [];
    lines.push(fields.join(','));
    for (const doc of docs) {
        lines.push(fields.map(f => JSON.stringify(resolveNestedField(doc, f) ?? '')).join(','));
    }
    return lines.join('\n');
}

/**
 * Собирает все ключи из массива документов, включая вложенные.
 * @param {Array} docs
 * @returns {Array<string>}
 */
function getAllKeys(docs) {
    const keys = new Set();
    for (const doc of docs) {
        collectKeysRecursive(doc, '', keys);
    }
    return Array.from(keys);
}

/**
 * Рекурсивно собирает ключи (вложенные как path.a.b).
 * @param {Object} obj
 * @param {string} prefix
 * @param {Set<string>} keys
 */
function collectKeysRecursive(obj, prefix, keys) {
    if (typeof obj !== 'object' || obj === null) return;
    for (const key of Object.keys(obj)) {
        const pathKey = prefix ? `${prefix}.${key}` : key;
        keys.add(pathKey);
        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
            collectKeysRecursive(obj[key], pathKey, keys);
        }
    }
}

/**
 * Получает значение поля по вложенному пути (path.a.b).
 * @param {Object} obj
 * @param {string} path
 * @returns {*}
 */
function resolveNestedField(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
            current = current[part];
        } else {
            return undefined;
        }
    }
    return current;
}

module.exports = {
    colorizeJson,
    escapeHtml,
    flattenDocToCsv
};
