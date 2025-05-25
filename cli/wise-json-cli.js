#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const WiseJSON = require('../wise-json/index.js');

const DB_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');

const LANG = (
    (process.env.WISE_JSON_LANG || '')
        .toLowerCase()
        .replace(/"/g, '') || // remove possible quotes
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
    find <collection> [query]
        - Найти документы (query — JS-функция-предикат как строка)
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
    find <collection> [query]
        - Find documents (query is a JS predicate function as string)
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

async function main() {
    const args = process.argv.slice(2).filter(x => !x.startsWith('--lang='));

    if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
        printHelp();
        process.exit(0);
    }

    const command = args[0];

    // --- list
    if (command === 'list') {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const cols = await db.getCollectionNames();
        console.log((LANG === 'ru' ? 'Коллекции:' : 'Collections:'), cols);
        process.exit(0);
    }

    // --- info
    if (command === 'info' && args[1]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(args[1]);
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
    if (command === 'insert' && args[1] && args[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(args[1]);
        await collection.initPromise;
        let doc;
        try {
            doc = JSON.parse(args[2]);
        } catch (e) {
            console.error(LANG === 'ru' ? 'Ошибка парсинга JSON' : 'JSON parse error');
            process.exit(1);
        }
        await collection.insert(doc);
        console.log((LANG === 'ru' ? 'Вставлено:' : 'Inserted:'), doc);
        process.exit(0);
    }

    // --- insert-many
    if (command === 'insert-many' && args[1] && args[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(args[1]);
        await collection.initPromise;
        const file = args[2];
        let data;
        try {
            data = JSON.parse(await fs.readFile(file, 'utf8'));
        } catch (e) {
            console.error(LANG === 'ru' ? 'Ошибка чтения или парсинга файла' : 'File read or parse error');
            process.exit(1);
        }
        let ttlArg = args.findIndex(a => a === '--ttl');
        let ttl = null;
        if (ttlArg !== -1 && args[ttlArg + 1]) {
            ttl = parseInt(args[ttlArg + 1], 10);
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

    // --- find
    if (command === 'find' && args[1]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(args[1]);
        await collection.initPromise;
        let queryFn = () => true;
        if (args[2]) {
            // Юзер может передать функцию
            queryFn = eval(`(${args[2]})`);
        }
        const docs = await collection.find(queryFn);
        console.log(JSON.stringify(docs, null, 2));
        process.exit(0);
    }

    // --- get
    if (command === 'get' && args[1] && args[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(args[1]);
        await collection.initPromise;
        const doc = await collection.getById(args[2]);
        console.log(JSON.stringify(doc, null, 2));
        process.exit(0);
    }

    // --- remove
    if (command === 'remove' && args[1] && args[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(args[1]);
        await collection.initPromise;
        await collection.remove(args[2]);
        console.log(
            LANG === 'ru'
                ? `Удалён: ${args[2]}`
                : `Removed ${args[2]}`
        );
        process.exit(0);
    }

    // --- clear
    if (command === 'clear' && args[1]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(args[1]);
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
    if (command === 'export' && args[1] && args[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(args[1]);
        await collection.initPromise;
        const docs = await collection.getAll();
        await fs.writeFile(args[2], JSON.stringify(docs, null, 2), 'utf8');
        console.log(
            LANG === 'ru'
                ? `Экспортировано ${docs.length} документов в ${args[2]}.`
                : `Exported ${docs.length} documents to ${args[2]}.`
        );
        process.exit(0);
    }

    // --- import
    if (command === 'import' && args[1] && args[2]) {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collection = await db.collection(args[1]);
        await collection.initPromise;
        let data;
        try {
            data = JSON.parse(await fs.readFile(args[2], 'utf8'));
        } catch (e) {
            console.error(LANG === 'ru' ? 'Ошибка чтения или парсинга файла' : 'File read or parse error');
            process.exit(1);
        }
        const inserted = await collection.insertMany(data);
        console.log(
            LANG === 'ru'
                ? `Импортировано ${inserted.length} документов из ${args[2]}.`
                : `Imported ${inserted.length} documents from ${args[2]}.`
        );
        process.exit(0);
    }

    // --- unknown command
    console.error(
        LANG === 'ru'
            ? 'Неизвестная команда. Используйте "help" для справки.'
            : 'Unknown command. Use "help" for usage.'
    );
    process.exit(1);
}

main();
