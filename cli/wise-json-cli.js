#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const WiseJSON = require('../wise-json/index.js');

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
    find <collection> [query] [--unsafe-eval]
        - Найти документы (query — или JS-функция-предикат как строка, или JSON-фильтр)
        - Для eval-предиката требуется флаг --unsafe-eval!
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
    find <collection> [query] [--unsafe-eval]
        - Find documents (query is either a JS predicate function string, or a JSON filter object)
        - For eval-predicate, --unsafe-eval flag is required!
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
    console.log(LANG === 'ru' ? RU_HELP : EN_HELP);
}

function prettyError(msg, code = 1) {
    console.error('\x1b[31m%s\x1b[0m', msg);
    process.exit(code);
}

async function main() {
    const args = process.argv.slice(2).filter(x => !x.startsWith('--lang='));
    const UNSAFE_EVAL = args.includes('--unsafe-eval');
    const cleanArgs = args.filter(a => a !== '--unsafe-eval');

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
        console.log((LANG === 'ru' ? 'Коллекции:' : 'Collections:'), cols);
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
            console.log('Статистика:', stats);
            console.log('Индексы:', indexes);
        } else {
            console.log('Stats:', stats);
            console.log('Indexes:', indexes);
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
        console.log((LANG === 'ru' ? 'Вставлено:' : 'Inserted:'), doc);
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
        console.log(
            LANG === 'ru'
                ? `Вставлено документов: ${inserted.length}.`
                : `Inserted ${inserted.length} documents.`
        );
        process.exit(0);
    }

    // --- find (safe: поддержка JSON-фильтра + eval только по флагу)
    if (command === 'find' && cleanArgs[1]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;

        let docs;
        // Если задан eval-фильтр и пользователь явно согласился на eval
        if (cleanArgs[2] && UNSAFE_EVAL) {
            try {
                // Предупреждение!
                console.warn('\x1b[33m%s\x1b[0m',
                    LANG === 'ru'
                        ? '[ВНИМАНИЕ] Использование eval-фильтра может быть ОПАСНО! Не используйте с непроверенными данными.'
                        : '[WARNING] Using eval-predicate may be UNSAFE! Do not use with untrusted data.'
                );
                // eslint-disable-next-line no-eval
                const queryFn = eval(`(${cleanArgs[2]})`);
                docs = await collection.find(queryFn);
            } catch (e) {
                prettyError(LANG === 'ru' ? 'Ошибка в функции фильтра (eval)' : 'Filter function (eval) error');
            }
        } else if (cleanArgs[2]) {
            // Попробуем как JSON-фильтр (простой поиск по полям)
            let filter;
            try {
                filter = JSON.parse(cleanArgs[2]);
            } catch (e) {
                prettyError(
                    LANG === 'ru'
                        ? 'Ошибка парсинга фильтра. Для произвольных JS-фильтров используйте --unsafe-eval.'
                        : 'Filter parse error. For arbitrary JS filter use --unsafe-eval.'
                );
            }
            docs = await collection.find(doc =>
                Object.entries(filter).every(([k, v]) => doc[k] === v)
            );
        } else {
            docs = await collection.find(() => true);
        }
        console.log(JSON.stringify(docs, null, 2));
        process.exit(0);
    }

    // --- get
    if (command === 'get' && cleanArgs[1] && cleanArgs[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        const doc = await collection.getById(cleanArgs[2]);
        console.log(JSON.stringify(doc, null, 2));
        process.exit(0);
    }

    // --- remove
    if (command === 'remove' && cleanArgs[1] && cleanArgs[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(cleanArgs[1]);
        await collection.initPromise;
        await collection.remove(cleanArgs[2]);
        console.log(
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
        console.log(
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
        console.log(
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
        console.log(
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
