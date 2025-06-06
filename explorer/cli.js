#!/usr/bin/env node

/**
 * explorer/cli.js
 * WiseJSON Data Explorer - CLI (расширенный)
 */

const fs = require('fs');
const path = require('path');
const process = require('process');
const WiseJSON = require('../wise-json/index.js');
const { colorizeJson, escapeHtml, flattenDocToCsv } = require('./utils.js');

const args = process.argv.slice(2);

// ReadOnly mode: по умолчанию true, но можно выключить через флаг --allow-write
const readOnlyMode = !args.includes('--allow-write');

// Path to DB
const DB_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');

function printUsage() {
    console.log(`
Usage:
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
}

async function main() {
    if (args.length === 0 || ['help', '--help', '-h'].includes(args[0])) {
        printUsage();
        process.exit(0);
    }

    const command = args[0];
    const db = new WiseJSON(DB_PATH);
    await db.init();

    try {
        switch (command) {
            case 'list-collections':
                await listCollections(db);
                break;
            case 'show-collection':
                await showCollection(db, args.slice(1));
                break;
            case 'get-document':
                await getDocument(db, args.slice(1));
                break;
            case 'collection-stats':
                await collectionStats(db, args.slice(1));
                break;
            case 'export-collection':
                await exportCollection(db, args.slice(1));
                break;
            case 'import-collection':
                await importCollection(db, args.slice(1));
                break;
            case 'list-indexes':
                await listIndexes(db, args.slice(1));
                break;
            case 'create-index':
                await createIndex(db, args.slice(1));
                break;
            case 'drop-index':
                await dropIndex(db, args.slice(1));
                break;
            default:
                console.error(`Unknown command: ${command}`);
                printUsage();
                process.exit(1);
        }
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    } finally {
        await db.close();
    }
}

async function listCollections(db) {
    const names = await db.getCollectionNames();
    if (names.length === 0) {
        console.log('No collections found.');
        return;
    }
    console.log('Collections:');
    for (const name of names) {
        const col = await db.collection(name);
        await col.initPromise;
        const count = await col.count();
        console.log(`  - ${name}: ${count}`);
    }
}

async function showCollection(db, params) {
    const colName = params[0];
    if (!colName) {
        console.error('Missing collectionName.');
        printUsage();
        process.exit(1);
    }
    const col = await db.collection(colName);
    await col.initPromise;

    // Добавляем проверку, что коллекция не пустая
    const count = await col.count();
    if (count === 0) {
        console.error(`Collection '${colName}' not found or empty.`);
        process.exit(1);
    }

    let docs = await col.getAll();

    const options = parseOptions(params.slice(1));
    if (options.filter) {
        try {
            const filterObj = JSON.parse(options.filter);
            docs = docs.filter(doc => Object.entries(filterObj).every(([k, v]) => doc[k] === v));
        } catch (err) {
            console.error('Invalid JSON filter. Try using escaped quotes, e.g.: --filter "{\\"name\\":\\"User5\\"}"');
            process.exit(1);
        }
    }

    if (options.sort) {
        docs.sort((a, b) => {
            const av = a[options.sort];
            const bv = b[options.sort];
            if (av === undefined) return 1;
            if (bv === undefined) return -1;
            if (av < bv) return options.order === 'desc' ? 1 : -1;
            if (av > bv) return options.order === 'desc' ? -1 : 1;
            return 0;
        });
    }

    const offset = options.offset || 0;
    const limit = options.limit || 10;
    const page = docs.slice(offset, offset + limit);

    if (options.file) {
        const output = options.output === 'csv' ? flattenDocToCsv(page) : JSON.stringify(page, null, 2);
        fs.writeFileSync(options.file, output, 'utf8');
        console.log(`Exported to ${options.file}`);
    } else {
        if (options.output === 'csv') {
            console.log(flattenDocToCsv(page));
        } else {
            for (const doc of page) {
                console.log(colorizeJson(JSON.stringify(doc, null, 2)));
            }
        }
        console.log(`Displayed ${page.length} documents.`);
    }
}


async function getDocument(db, params) {
    const [colName, docId] = params;
    if (!colName || !docId) {
        console.error('Missing parameters.');
        printUsage();
        process.exit(1);
    }
    const col = await db.collection(colName);
    await col.initPromise;
    const doc = await col.getById(docId);
    if (!doc) {
        console.log(`Document with ID '${docId}' not found.`);
        return;
    }
    console.log(colorizeJson(JSON.stringify(doc, null, 2)));
}

async function collectionStats(db, params) {
    const colName = params[0];
    if (!colName) {
        console.error('Missing collectionName.');
        printUsage();
        process.exit(1);
    }
    const col = await db.collection(colName);
    await col.initPromise;
    const stats = await col.stats();
    const indexes = await col.getIndexes();
    console.log(colorizeJson(JSON.stringify({ ...stats, indexes }, null, 2)));
}

async function exportCollection(db, params) {
    const [colName, file] = params;
    if (!colName || !file) {
        console.error('Missing collectionName or filename.');
        printUsage();
        process.exit(1);
    }
    const options = parseOptions(params.slice(2));
    const col = await db.collection(colName);
    await col.initPromise;
    if (options.output === 'csv') {
        await col.exportCsv(file);
    } else {
        await col.exportJson(file);
    }
}

async function importCollection(db, params) {
    const [colName, file] = params;
    if (!colName || !file) {
        console.error('Missing collectionName or filename.');
        printUsage();
        process.exit(1);
    }
    if (readOnlyMode) {
        console.error('ReadOnlyMode: Import is not allowed.');
        process.exit(1);
    }
    const options = parseOptions(params.slice(2));
    const col = await db.collection(colName);
    await col.initPromise;
    await col.importJson(file, { mode: options.mode });
}

async function listIndexes(db, params) {
    const colName = params[0];
    if (!colName) {
        console.error('Missing collectionName.');
        printUsage();
        process.exit(1);
    }
    const col = await db.collection(colName);
    await col.initPromise;
    const indexes = await col.getIndexes();
    console.log(colorizeJson(JSON.stringify(indexes, null, 2)));
}

async function createIndex(db, params) {
    const [colName, fieldName] = params;
    if (!colName || !fieldName) {
        console.error('Missing collectionName or fieldName.');
        printUsage();
        process.exit(1);
    }
    if (readOnlyMode) {
        console.error('ReadOnlyMode: Cannot create index.');
        process.exit(1);
    }
    const unique = params.includes('--unique');
    const col = await db.collection(colName);
    await col.initPromise;
    await col.createIndex(fieldName, { unique });
    console.log(`Index on field '${fieldName}' created (unique: ${unique}).`);
}

async function dropIndex(db, params) {
    const [colName, fieldName] = params;
    if (!colName || !fieldName) {
        console.error('Missing collectionName or fieldName.');
        printUsage();
        process.exit(1);
    }
    if (readOnlyMode) {
        console.error('ReadOnlyMode: Cannot drop index.');
        process.exit(1);
    }
    const col = await db.collection(colName);
    await col.initPromise;
    await col.dropIndex(fieldName);
    console.log(`Index on field '${fieldName}' dropped.`);
}

function parseOptions(params) {
    const options = {};
    for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (p === '--limit' && params[i + 1]) options.limit = parseInt(params[++i], 10);
        else if (p === '--offset' && params[i + 1]) options.offset = parseInt(params[++i], 10);
        else if (p === '--sort' && params[i + 1]) options.sort = params[++i];
        else if (p === '--order' && params[i + 1]) options.order = params[++i];
        else if (p === '--filter' && params[i + 1]) options.filter = params[++i];
        else if (p === '--output' && params[i + 1]) options.output = params[++i];
        else if (p === '--file' && params[i + 1]) options.file = params[++i];
        else if (p === '--mode' && params[i + 1]) options.mode = params[++i];
    }
    return options;
}

main();
