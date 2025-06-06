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

// flattenDocToCsv перенесена в wise-json/collection/utils.js

module.exports = {
    colorizeJson,
    escapeHtml,
    // flattenDocToCsv - больше не экспортируется здесь, см. wise-json/collection/utils.js
};
