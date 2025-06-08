#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const WiseJSON = require('../wise-json/index.js');

const logger = require('../wise-json/logger');

/**
 * Проверяет документ на соответствие фильтру с поддержкой операторов ($gt, $lt, $in, $regex и т.д.)
 * @param {object} doc
 * @param {object} filter
 * @returns {boolean}
 */
function matchFilter(doc, filter) {
    if (typeof filter !== 'object' || filter == null) return false;

    // Логика $or/$and на верхнем уровне фильтра
    if (Array.isArray(filter.$or)) {
        return filter.$or.some(f => matchFilter(doc, f));
    }
    if (Array.isArray(filter.$and)) {
        return filter.$and.every(f => matchFilter(doc, f));
    }

    // По всем полям фильтра
    for (const key of Object.keys(filter)) {
        if (key === '$or' || key === '$and') continue;
        const cond = filter[key];
        const value = doc[key];

        if (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) {
            // Операторы
            for (const op of Object.keys(cond)) {
                const opVal = cond[op];
                switch (op) {
                    case '$gt':
                        if (!(value > opVal)) return false;
                        break;
                    case '$gte':
                        if (!(value >= opVal)) return false;
                        break;
                    case '$lt':
                        if (!(value < opVal)) return false;
                        break;
                    case '$lte':
                        if (!(value <= opVal)) return false;
                        break;
                    case '$ne':
                        if (value === opVal) return false;
                        break;
                    case '$in':
                        if (!Array.isArray(opVal) || !opVal.includes(value)) return false;
                        break;
                    case '$nin':
                        if (Array.isArray(opVal) && opVal.includes(value)) return false;
                        break;
                    case '$regex':
                        {
                            let re = opVal;
                            if (typeof re === 'string') {
                                re = new RegExp(re, cond.$options || '');
                            }
                            if (typeof value !== 'string' || !re.test(value)) return false;
                        }
                        break;
                    default:
                        // Неизвестный оператор: игнорируем (или можно throw)
                        return false;
                }
            }
        } else {
            // Прямое сравнение (равенство)
            if (value !== cond) return false;
        }
    }
    return true;
}

const DB_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');

const LANG = (
    (process.env.WISE_JSON_LANG || '')
        .toLowerCase()
        .replace(/"/g, '') ||
    (process.argv.includes('--lang=ru') ? 'ru' : '') ||
    (process.argv.includes('--lang=en') ? 'en' : '')
) || 'en';

const RU_HELP = `
wise-json-cli <команда> [опции]

  Команды:
    list
        - Показать все коллекции
    info <collection>
        - Статистика и индексы коллекции
    insert <collection> <json>
        - Вставить один документ (json-строка)
    insert-many <collection> <file.json> [--ttl <ms>]
        - Вставить пакет документов из файла (массив JSON)
        - Опционально: TTL (время жизни, мс)
    find <collection> [filter]
        - Найти документы (filter — JSON-объект с поддержкой операторов: $gt, $lt, $in, $regex, $or, $and)
        - Пример: '{"age":{"$gt":30}}' или '{"$or":[{"city":"Moscow"},{"age":{"$lt":18}}]}'
    get <collection> <id>
        - Получить документ по id
    remove <collection> <id>
        - Удалить документ по id
    clear <collection>
        - Очистить коллекцию
    export <collection> <file.json>
        - Экспорт всей коллекции в файл
    import <collection> <file.json>
        - Импортировать массив документов из файла (insertMany)
    help
        - Показать эту справку

  ENV:
    WISE_JSON_PATH - путь к директории базы данных (по умолчанию ./wise-json-db-data)
    WISE_JSON_LANG - язык интерфейса (ru или en)
`;

const EN_HELP = `
wise-json-cli <command> [options]

  Commands:
    list
        - Show all collections
    info <collection>
        - Collection stats and indexes
    insert <collection> <json>
        - Insert a single document (as JSON string)
    insert-many <collection> <file.json> [--ttl <ms>]
        - Batch insert documents from a file (JSON array)
        - Optional: TTL (time to live, ms)
    find <collection> [filter]
        - Find documents (filter is a JSON object supporting: $gt, $lt, $in, $regex, $or, $and)
        - Example: '{"age":{"$gt":30}}' or '{"$or":[{"city":"Moscow"},{"age":{"$lt":18}}]}'
    get <collection> <id>
        - Get document by id
    remove <collection> <id>
        - Remove document by id
    clear <collection>
        - Clear collection
    export <collection> <file.json>
        - Export all documents to a file
    import <collection> <file.json>
        - Import array of documents from file (insertMany)
    help
        - Show this help

  ENV:
    WISE_JSON_PATH - path to database directory (default: ./wise-json-db-data)
    WISE_JSON_LANG - interface language (ru or en)
`;

function printHelp() {
    logger.log(LANG === 'ru' ? RU_HELP : EN_HELP);
}

function prettyError(msg, code = 1) {
    logger.error('\x1b[31m%s\x1b[0m', msg);
    process.exit(code);
}

async function main() {
    const args = process.argv.slice(2).filter(x => !x.startsWith('--lang='));
    const cleanArgs = args;

    if (cleanArgs.length === 0 || cleanArgs[0] === 'help' || cleanArgs[0] === '--help') {
        printHelp();
        process.exit(0);
    }

    const command = cleanArgs[0];

    // --- list
    if (command === 'list') {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const cols = await db.getCollectionNames();
        logger.log((LANG === 'ru' ? 'Коллекции:' : 'Collections:'), cols);
        process.exit(0);
    }

    // --- info
    if (command === 'info' && cleanArgs[1]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        const stats = await collection.stats();
        const indexes = await collection.getIndexes();
        if (LANG === 'ru') {
            logger.log('Статистика:', stats);
            logger.log('Индексы:', indexes);
        } else {
            logger.log('Stats:', stats);
            logger.log('Indexes:', indexes);
        }
        process.exit(0);
    }

    // --- insert
    if (command === 'insert' && cleanArgs[1] && cleanArgs[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        let doc;
        try {
            doc = JSON.parse(cleanArgs[2]);
        } catch (e) {
            prettyError(LANG === 'ru' ? 'Ошибка парсинга JSON' : 'JSON parse error');
        }
        await collection.insert(doc);
        logger.log((LANG === 'ru' ? 'Вставлено:' : 'Inserted:'), doc);
        process.exit(0);
    }

    // --- insert-many
    if (command === 'insert-many' && cleanArgs[1] && cleanArgs[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        const file = cleanArgs[2];
        let data;
        try {
            data = JSON.parse(await fs.readFile(file, 'utf8'));
        } catch (e) {
            prettyError(LANG === 'ru' ? 'Ошибка чтения или парсинга файла' : 'File read or parse error');
        }
        let ttlArg = cleanArgs.findIndex(a => a === '--ttl');
        let ttl = null;
        if (ttlArg !== -1 && cleanArgs[ttlArg + 1]) {
            ttl = parseInt(cleanArgs[ttlArg + 1], 10);
        }
        const now = Date.now();
        if (ttl) {
            data = data.map(doc => ({ ...doc, expireAt: now + ttl }));
        }
        const inserted = await collection.insertMany(data);
        logger.log(
            LANG === 'ru'
                ? `Вставлено документов: ${inserted.length}.`
                : `Inserted ${inserted.length} documents.`
        );
        process.exit(0);
    }

    // --- find (расширенный JSON-фильтр)
    if (command === 'find' && cleanArgs[1]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;

        let docs;
        if (cleanArgs[2]) {
            let filter;
            try {
                filter = JSON.parse(cleanArgs[2]);
            } catch (e) {
                prettyError(
                    LANG === 'ru'
                        ? 'Ошибка парсинга фильтра (ожидается JSON-объект).'
                        : 'Filter parse error (expecting JSON object).'
                );
            }
            docs = await collection.find(doc => matchFilter(doc, filter));
        } else {
            docs = await collection.find(() => true);
        }
        logger.log(JSON.stringify(docs, null, 2));
        process.exit(0);
    }

    // --- get
    if (command === 'get' && cleanArgs[1] && cleanArgs[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        const doc = await collection.getById(cleanArgs[2]);
        logger.log(JSON.stringify(doc, null, 2));
        process.exit(0);
    }

    // --- remove
    if (command === 'remove' && cleanArgs[1] && cleanArgs[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        await collection.remove(cleanArgs[2]);
        logger.log(
            LANG === 'ru'
                ? `Удалён: ${cleanArgs[2]}`
                : `Removed ${cleanArgs[2]}`
        );
        process.exit(0);
    }

    // --- clear
    if (command === 'clear' && cleanArgs[1]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        await collection.clear();
        logger.log(
            LANG === 'ru'
                ? 'Коллекция очищена.'
                : 'Collection cleared.'
        );
        process.exit(0);
    }

    // --- export
    if (command === 'export' && cleanArgs[1] && cleanArgs[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        const docs = await collection.getAll();
        await fs.writeFile(cleanArgs[2], JSON.stringify(docs, null, 2), 'utf8');
        logger.log(
            LANG === 'ru'
                ? `Экспортировано ${docs.length} документов в ${cleanArgs[2]}.`
                : `Exported ${docs.length} documents to ${cleanArgs[2]}.`
        );
        process.exit(0);
    }

    // --- import
    if (command === 'import' && cleanArgs[1] && cleanArgs[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        let data;
        try {
            data = JSON.parse(await fs.readFile(cleanArgs[2], 'utf8'));
        } catch (e) {
            prettyError(LANG === 'ru' ? 'Ошибка чтения или парсинга файла' : 'File read or parse error');
        }
        const inserted = await collection.insertMany(data);
        logger.log(
            LANG === 'ru'
                ? `Импортировано ${inserted.length} документов из ${cleanArgs[2]}.`
                : `Imported ${inserted.length} documents from ${cleanArgs[2]}.`
        );
        process.exit(0);
    }

    // --- unknown command
    prettyError(
        LANG === 'ru'
            ? 'Неизвестная команда. Используйте "help" для справки.'
            : 'Unknown command. Use "help" for usage.',
        1
    );
}

main();
