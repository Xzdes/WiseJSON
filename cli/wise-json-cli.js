#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const WiseJSON = require('../index.js'); // Путь к главному файлу
const logger = require('../logger.js');
const { matchFilter } = require('../collection/utils.js');

const DB_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');

const LANG = (process.env.WISE_JSON_LANG || (process.argv.includes('--lang=ru') ? 'ru' : 'en')).toLowerCase();

const HELP_TEXT = {
    ru: `...`, // вставьте сюда русский текст справки
    en: `
wise-json <command> [options]

Commands:
  list
      - Show all collections.
  info <collection>
      - Collection stats and indexes.
  insert <collection> <json>
      - Insert a single document (as JSON string).
  insert-many <collection> <file.json> [--ttl <ms>]
      - Batch insert from a file.
  find <collection> [filter]
      - Find documents using a MongoDB-like filter.
      - Example: '{"age":{"$gt":30}}' or '{"$or":[{"city":"Moscow"}]}'
  get <collection> <id>
      - Get a document by its ID.
  remove <collection> <id>
      - Remove a document by its ID.
  clear <collection>
      - Clear all documents from a collection.
  export <collection> <file.json>
      - Export all documents to a JSON file.
  import <collection> <file.json>
      - Import documents from a JSON file.
  help
      - Show this help message.
`
};

function printHelp() {
    console.log(HELP_TEXT[LANG] || HELP_TEXT['en']);
}

function prettyError(msg, code = 1) {
    logger.error(`Error: ${msg}`);
    process.exit(code);
}

async function run() {
    const args = process.argv.slice(2).filter(x => !x.startsWith('--lang='));
    const command = args[0];

    if (!command || ['help', '--help'].includes(command)) {
        printHelp();
        return;
    }

    const db = new WiseJSON(DB_PATH, {
        ttlCleanupIntervalMs: 0,
        checkpointIntervalMs: 0,
    });
    
    try {
        await db.init();
        const collectionName = args[1];
        
        switch (command) {
            case 'list': {
                const cols = await db.getCollectionNames();
                console.log((LANG === 'ru' ? 'Коллекции:' : 'Collections:'), cols);
                break;
            }
            case 'info': {
                if (!collectionName) prettyError('Collection name is required.');
                const col = await db.collection(collectionName);
                await col.initPromise;
                console.log('Stats:', await col.stats());
                console.log('Indexes:', await col.getIndexes());
                break;
            }
            case 'insert': {
                if (!collectionName || !args[2]) prettyError('Usage: insert <collection> <json>');
                const col = await db.collection(collectionName);
                await col.initPromise;
                const doc = JSON.parse(args[2]);
                const inserted = await col.insert(doc);
                console.log(JSON.stringify(inserted, null, 2));
                break;
            }
            case 'insert-many':
            case 'import': { // import - это алиас для insert-many
                if (!collectionName || !args[2]) prettyError('Usage: insert-many <collection> <file.json>');
                const col = await db.collection(collectionName);
                await col.initPromise;
                const data = JSON.parse(await fs.readFile(args[2], 'utf8'));
                if (!Array.isArray(data)) prettyError('Input file must contain a JSON array.');
                
                const ttlArgIndex = args.indexOf('--ttl');
                if (ttlArgIndex > -1 && args[ttlArgIndex + 1]) {
                    const ttl = parseInt(args[ttlArgIndex + 1], 10);
                    const now = Date.now();
                    data.forEach(doc => doc.expireAt = now + ttl);
                }
                
                const inserted = await col.insertMany(data);
                logger.log(`Inserted ${inserted.length} documents.`);
                break;
            }
            case 'find': {
                if (!collectionName) prettyError('Collection name is required.');
                const col = await db.collection(collectionName);
                await col.initPromise;
                let filter = {};
                if (args[2]) {
                    try {
                        filter = JSON.parse(args[2]);
                    } catch {
                        prettyError('Invalid JSON filter.');
                    }
                }
                // Используем новый API
                const docs = await col.find(filter);
                console.log(JSON.stringify(docs, null, 2));
                break;
            }
            case 'get': {
                if (!collectionName || !args[2]) prettyError('Usage: get <collection> <id>');
                const col = await db.collection(collectionName);
                await col.initPromise;
                const doc = await col.getById(args[2]);
                console.log(JSON.stringify(doc, null, 2));
                break;
            }
            case 'remove': {
                if (!collectionName || !args[2]) prettyError('Usage: remove <collection> <id>');
                const col = await db.collection(collectionName);
                await col.initPromise;
                const success = await col.remove(args[2]);
                logger.log(success ? `Removed: ${args[2]}` : 'Document not found.');
                break;
            }
            case 'clear': {
                if (!collectionName) prettyError('Collection name is required.');
                const col = await db.collection(collectionName);
                await col.initPromise;
                await col.clear();
                logger.log(`Collection "${collectionName}" cleared.`);
                break;
            }
            case 'export': {
                if (!collectionName || !args[2]) prettyError('Usage: export <collection> <file.json>');
                const col = await db.collection(collectionName);
                await col.initPromise;
                const docs = await col.getAll();
                await fs.writeFile(args[2], JSON.stringify(docs, null, 2), 'utf8');
                logger.log(`Exported ${docs.length} documents to ${args[2]}.`);
                break;
            }
            default:
                prettyError(`Unknown command: "${command}". Use 'help' for usage.`);
        }
    } finally {
        if (db) {
            await db.close();
        }
    }
}

run().catch(err => {
    // db.close() будет вызван в finally даже при ошибке
    prettyError(err.message);
});