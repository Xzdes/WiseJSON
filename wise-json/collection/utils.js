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

/**
 * Проверяет, соответствует ли документ декларативному фильтру (в стиле MongoDB).
 * @param {object} doc - Документ для проверки.
 * @param {object} filter - Объект фильтра.
 * @returns {boolean}
 */
function matchFilter(doc, filter) {
    if (typeof filter !== 'object' || filter == null || doc === null || typeof doc !== 'object') {
        return false;
    }

    if (Array.isArray(filter.$or)) {
        return filter.$or.some(f => matchFilter(doc, f));
    }
    if (Array.isArray(filter.$and)) {
        return filter.$and.every(f => matchFilter(doc, f));
    }

    for (const key of Object.keys(filter)) {
        if (key === '$or' || key === '$and') continue;

        const cond = filter[key];
        const value = doc[key];

        if (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) {
            for (const op of Object.keys(cond)) {
                const opVal = cond[op];
                let match = true;
                switch (op) {
                    case '$gt':   if (!(value > opVal)) match = false; break;
                    case '$gte':  if (!(value >= opVal)) match = false; break;
                    case '$lt':   if (!(value < opVal)) match = false; break;
                    case '$lte':  if (!(value <= opVal)) match = false; break;
                    case '$ne':   if (value === opVal) match = false; break;
                    
                    // --- ИЗМЕНЕНИЕ ЗДЕСЬ ---
                    case '$in': {
                        if (!Array.isArray(opVal)) {
                            match = false;
                        } else if (Array.isArray(value)) {
                            // Если поле в документе - массив, проверяем пересечение
                            match = value.some(item => opVal.includes(item));
                        } else {
                            // Если поле в документе - простое значение
                            match = opVal.includes(value);
                        }
                        break;
                    }
                    case '$nin': {
                        if (!Array.isArray(opVal)) {
                            match = false;
                        } else if (Array.isArray(value)) {
                            // Если поле в документе - массив, проверяем отсутствие пересечений
                            match = !value.some(item => opVal.includes(item));
                        } else {
                            // Если поле в документе - простое значение
                            match = !opVal.includes(value);
                        }
                        break;
                    }
                    // --- КОНЕЦ ИЗМЕНЕНИЯ ---

                    case '$exists': if ((value !== undefined) !== opVal) match = false; break;
                    case '$regex': {
                        if (typeof value !== 'string') {
                            match = false;
                        } else {
                            try {
                                const re = new RegExp(opVal, cond.$options || '');
                                if (!re.test(value)) match = false;
                            } catch (e) {
                                match = false;
                            }
                        }
                        break;
                    }
                    default:
                        match = false;
                        break;
                }
                if (!match) return false;
            }
        } else {
            if (value !== cond) return false;
        }
    }
    return true;
}

module.exports = {
    defaultIdGenerator,
    isNonEmptyString,
    isPlainObject,
    makeAbsolutePath,
    validateOptions,
    flattenDocToCsv,
    matchFilter,
};