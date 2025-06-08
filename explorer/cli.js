#!/usr/bin/env node

/**
 * explorer/cli.js — CLI Data Explorer для WiseJSON
 */

const fs = require('fs');
const fsAsync = require('fs/promises');
const path = require('path');
const WiseJSON = require('../wise-json/index.js');

const logger = require('../wise-json/logger');

const DB_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');

/**
 * Быстрый вывод ошибки и выход
 */
function prettyError(msg, code = 1) {
    logger.error('\x1b[31m%s\x1b[0m', msg);
    process.exit(code);
}

/**
 * Проверяет существование коллекции (физически на диске)
 */
function assertCollectionExists(collectionName) {
    const colPath = path.join(DB_PATH, collectionName);
    if (!fs.existsSync(colPath)) {
        prettyError(`Collection "${collectionName}" does not exist.`, 1);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || ['help', '--help', '-h'].includes(command)) {
        logger.log(`
wisejson-explorer <command> [options]

Commands:
  list-collections
      List all collections with document counts.

  show-collection <collectionName> [--limit N] [--offset M] [--sort <field>] [--order asc|desc] [--filter <JSON_string>] [--output json|table|csv] [--file <filename>]
      Display documents in the specified collection.

  get-document <collectionName> <documentId>
      Show a single document by ID.

  collection-stats <collectionName>
      Show collection statistics.

  export-collection <collectionName> <filename> [--output json|csv]
      Export collection to JSON or CSV file.

  import-collection <collectionName> <filename> [--mode append|replace]
      Import collection from JSON file.

  list-indexes <collectionName>
      List indexes for the collection.

  create-index <collectionName> <fieldName> [--unique]
      Create an index on a field.

  drop-index <collectionName> <fieldName>
      Drop an index from a field.

Options:
  --limit N, --offset M, --sort, --order, --filter
  --output json|csv
  --file <filename>
  --mode append|replace
  --allow-write
`);
        process.exit(0);
    }

    // list-collections
    if (command === 'list-collections') {
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const collections = await db.getCollectionNames();
        for (const col of collections) {
            const collection = await db.collection(col);
            await collection.initPromise;
            const count = await collection.count();
            logger.log(`${col}: ${count} documents`);
        }
        process.exit(0);
    }

    // show-collection <collectionName>
    if (command === 'show-collection' && args[1]) {
        const collectionName = args[1];
        assertCollectionExists(collectionName);
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(collectionName);
        await col.initPromise;

        let limit = 10;
        let offset = 0;
        let sortField = null;
        let sortOrder = 'asc';
        let output = 'json';
        let filter = null;

        for (let i = 2; i < args.length; i++) {
            const arg = args[i];
            if (arg === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
            if (arg === '--offset' && args[i + 1]) offset = parseInt(args[++i], 10);
            if (arg === '--sort' && args[i + 1]) sortField = args[++i];
            if (arg === '--order' && args[i + 1]) sortOrder = args[++i];
            if (arg === '--output' && args[i + 1]) output = args[++i];
            if (arg === '--filter' && args[i + 1]) filter = args[++i];
        }

        let docs = await col.getAll();
        if (filter) {
            try {
                const obj = JSON.parse(filter);
                docs = docs.filter(doc => {
                    for (const key in obj) {
                        if (typeof obj[key] === 'object') {
                            for (const op in obj[key]) {
                                switch (op) {
                                    case '$gt': if (!(doc[key] > obj[key][op])) return false; break;
                                    case '$lt': if (!(doc[key] < obj[key][op])) return false; break;
                                    case '$gte': if (!(doc[key] >= obj[key][op])) return false; break;
                                    case '$lte': if (!(doc[key] <= obj[key][op])) return false; break;
                                    case '$ne': if (doc[key] === obj[key][op]) return false; break;
                                    case '$in': if (!Array.isArray(obj[key][op]) || !obj[key][op].includes(doc[key])) return false; break;
                                    case '$nin': if (Array.isArray(obj[key][op]) && obj[key][op].includes(doc[key])) return false; break;
                                    default: return false;
                                }
                            }
                        } else {
                            if (doc[key] !== obj[key]) return false;
                        }
                    }
                    return true;
                });
            } catch (e) {
                prettyError('Invalid JSON filter. Try using escaped quotes, e.g.: --filter "{\\"name\\":\\"User5\\"}"');
            }
        }

        if (sortField) {
            docs.sort((a, b) => {
                if (a[sortField] === undefined) return 1;
                if (b[sortField] === undefined) return -1;
                if (a[sortField] < b[sortField]) return sortOrder === 'asc' ? -1 : 1;
                if (a[sortField] > b[sortField]) return sortOrder === 'asc' ? 1 : -1;
                return 0;
            });
        }

        docs = docs.slice(offset, offset + limit);

        if (output === 'json') {
            logger.log(JSON.stringify(docs, null, 2));
        } else if (output === 'csv') {
            const { flattenDocToCsv } = require('./utils.js');
            logger.log(flattenDocToCsv(docs));
        } else if (output === 'table') {
            logger.table(docs);
        }

        process.exit(0);
    }

    // get-document <collectionName> <id>
    if (command === 'get-document' && args[1] && args[2]) {
        const collectionName = args[1];
        assertCollectionExists(collectionName);
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(collectionName);
        await col.initPromise;
        const doc = await col.getById(args[2]);
        if (!doc) {
            prettyError(`Document "${args[2]}" not found in collection "${collectionName}"`, 1);
        }
        logger.log(JSON.stringify(doc, null, 2));
        process.exit(0);
    }

    // collection-stats <collectionName>
    if (command === 'collection-stats' && args[1]) {
        const collectionName = args[1];
        assertCollectionExists(collectionName);
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(collectionName);
        await col.initPromise;
        const stats = await col.stats();
        logger.log(stats);
        process.exit(0);
    }

    // export-collection <collectionName> <filename>
    if (command === 'export-collection' && args[1] && args[2]) {
        const collectionName = args[1];
        assertCollectionExists(collectionName);
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(collectionName);
        await col.initPromise;
        const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : 'json';
        if (output === 'csv') {
            await col.exportCsv(args[2]);
            logger.log(`Exported to ${args[2]}`);
        } else {
            await col.exportJson(args[2]);
        }
        process.exit(0);
    }

    // import-collection <collectionName> <filename>
    if (command === 'import-collection' && args[1] && args[2]) {
        const collectionName = args[1];
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(collectionName);
        await col.initPromise;
        const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'append';
        await col.importJson(args[2], { mode });
        await col.flushToDisk(); // ГАРАНТИРУЕТ создание коллекции на диске!
        process.exit(0);
    }

    // list-indexes <collectionName>
    if (command === 'list-indexes' && args[1]) {
        const collectionName = args[1];
        assertCollectionExists(collectionName);
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(collectionName);
        await col.initPromise;
        logger.log(await col.getIndexes());
        process.exit(0);
    }

    // create-index <collectionName> <fieldName>
    if (command === 'create-index' && args[1] && args[2]) {
        const collectionName = args[1];
        assertCollectionExists(collectionName);
        const fieldName = args[2];
        const unique = args.includes('--unique');
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(collectionName);
        await col.initPromise;
        await col.createIndex(fieldName, { unique });
        logger.log(`Index on field '${fieldName}' created (unique: ${unique}).`);
        process.exit(0);
    }

    // drop-index <collectionName> <fieldName>
    if (command === 'drop-index' && args[1] && args[2]) {
        const collectionName = args[1];
        assertCollectionExists(collectionName);
        const fieldName = args[2];
        const db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(collectionName);
        await col.initPromise;
        await col.dropIndex(fieldName);
        logger.log(`Index on field '${fieldName}' dropped.`);
        process.exit(0);
    }

    // Если команда не распознана
    prettyError('Unknown command. Use "help" for usage.', 1);
}

main();
