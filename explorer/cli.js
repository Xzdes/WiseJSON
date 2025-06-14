#!/usr/bin/env node

/**
 * explorer/cli.js — CLI Data Explorer для WiseJSON
 */

const fs = require('fs');
const fsAsync = require('fs/promises');
const path = require('path');
const readline = require('readline');
const WiseJSON = require('../wise-json/index.js');
const logger = require('../wise-json/logger');
const { matchFilter, flattenDocToCsv } = require('../wise-json/collection/utils.js');

const DB_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');

function prettyError(msg, code = 1) {
    if (process.argv.includes('--json-errors')) {
        process.stderr.write(JSON.stringify({ error: true, message: msg, code }));
    } else {
        logger.error(`Error: ${msg}`);
    }
    process.exit(code);
}

async function assertCollectionExists(collectionName) {
    const colPath = path.join(DB_PATH, collectionName);
    try {
        await fsAsync.access(colPath);
    } catch {
        prettyError(`Collection "${collectionName}" does not exist.`);
    }
}

async function confirmAction(prompt) {
    if (process.argv.includes('--force') || process.argv.includes('--yes')) {
        return true;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(`${prompt} [y/N] `, answer => {
            rl.close();
            resolve(answer.toLowerCase() === 'y');
        });
    });
}

async function run() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || ['help', '--help', '-h'].includes(command)) {
        console.log(`
wisejson-explorer <command> [options]

Management Commands (require --allow-write):
  collection-drop <collectionName>       Permanently deletes a collection.
  doc-insert <collectionName> <json>     Inserts a single document.
  doc-remove <collectionName> <docId>      Removes a single document by its ID.
  import-collection <coll> <file>      Imports documents from a JSON file.
      [--mode append|replace]              - (Default: append)
  create-index <coll> <field> [--unique] Creates an index on a field.
  drop-index <coll> <field>              Drops an index from a field.

Read-Only Commands:
  list-collections                       Lists all collections with document counts.
  show-collection <coll>                 Displays documents in a collection.
      [--limit N] [--offset M]             - Pagination
      [--sort <field>] [--order asc|desc]  - Sorting
      [--filter <JSON_string>]             - Filter documents (e.g., '{"age":{"$gt":25}}')
      [--output json|table|csv]            - Output format
  get-document <coll> <docId>              Shows a single document by ID.
  collection-stats <coll>                Shows collection statistics and indexes.
  list-indexes <coll>                    Lists indexes for the collection.
  export-collection <coll> <file>        Exports a collection to a file.
      [--output json|csv]                  - Output format

Global Options:
  --allow-write                          Required for any command that modifies data.
  --force, --yes                         Skip confirmation prompts for dangerous operations.
  --json-errors                          Output errors in JSON format.
`);
        return;
    }

    const writeCommands = ['collection-drop', 'doc-insert', 'doc-remove', 'import-collection', 'create-index', 'drop-index'];
    if (writeCommands.includes(command) && !args.includes('--allow-write')) {
        prettyError(`Write operation "${command}" requires the --allow-write flag.`);
    }

    const db = new WiseJSON(DB_PATH, {
        ttlCleanupIntervalMs: 0,
        checkpointIntervalMs: 0,
    });

    try {
        await db.init();
        const collectionName = args[1];

        switch (command) {
            case 'list-collections': {
                const collections = await db.getCollectionNames();
                const result = await Promise.all(collections.map(async (name) => {
                    const col = await db.collection(name);
                    await col.initPromise;
                    return { name, count: await col.count() };
                }));
                console.table(result);
                break;
            }
            case 'doc-insert': {
                if (!collectionName || !args[2]) prettyError('Usage: doc-insert <collection> <json>');
                const col = await db.collection(collectionName);
                await col.initPromise;
                try {
                    const doc = JSON.parse(args[2]);
                    const inserted = await col.insert(doc);
                    console.log(JSON.stringify(inserted, null, 2));
                } catch (e) { prettyError(`Failed to insert document: ${e.message}`); }
                break;
            }
            case 'import-collection': {
                if (!collectionName || !args[2]) prettyError('Usage: import-collection <collection> <file>');
                const col = await db.collection(collectionName);
                await col.initPromise;
                const filename = args[2];
                const mode = args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'replace' ? 'replace' : 'append';
                await col.importJson(filename, { mode });
                logger.log(`Import to "${collectionName}" from ${filename} completed (mode: ${mode}).`);
                break;
            }
            case 'create-index': {
                if (!collectionName || !args[2]) prettyError('Usage: create-index <collection> <field> [--unique]');
                const col = await db.collection(collectionName);
                await col.initPromise;
                await col.createIndex(args[2], { unique: args.includes('--unique') });
                logger.log(`Index created on ${collectionName}.${args[2]}`);
                break;
            }
            case 'show-collection': {
                if (!collectionName) prettyError('Usage: show-collection <collection>');
                await assertCollectionExists(collectionName);
                const col = await db.collection(collectionName);
                await col.initPromise;
                let limit = 10, offset = 0, sortField = null, sortOrder = 'asc', output = 'json', filter = null;
                for (let i = 2; i < args.length; i++) {
                    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
                    if (args[i] === '--offset' && args[i + 1]) offset = parseInt(args[++i], 10);
                    if (args[i] === '--sort' && args[i + 1]) sortField = args[++i];
                    if (args[i] === '--order' && args[i + 1]) sortOrder = args[++i];
                    if (args[i] === '--output' && args[i + 1]) output = args[++i];
                    if (args[i] === '--filter' && args[i + 1]) {
                        try { filter = JSON.parse(args[++i]); } catch (e) { prettyError(`Invalid JSON in filter: ${e.message}`); }
                    }
                }
                let docs = await col.find(filter || (() => true));
                if (sortField) {
                    docs.sort((a, b) => {
                        if (a[sortField] === undefined) return 1; if (b[sortField] === undefined) return -1;
                        if (a[sortField] < b[sortField]) return sortOrder === 'asc' ? -1 : 1;
                        if (a[sortField] > b[sortField]) return sortOrder === 'asc' ? 1 : -1;
                        return 0;
                    });
                }
                docs = docs.slice(offset, offset + limit);
                if (output === 'json') console.log(JSON.stringify(docs, null, 2));
                else if (output === 'csv') console.log(flattenDocToCsv(docs));
                else console.table(docs);
                break;
            }
            case 'get-document': {
                if (!collectionName || !args[2]) prettyError('Usage: get-document <collection> <docId>');
                await assertCollectionExists(collectionName);
                const col = await db.collection(collectionName);
                await col.initPromise;
                const doc = await col.getById(args[2]);
                if (!doc) prettyError(`Document "${args[2]}" not found.`);
                console.log(JSON.stringify(doc, null, 2));
                break;
            }
            case 'collection-stats': {
                if (!collectionName) prettyError('Usage: collection-stats <collection>');
                await assertCollectionExists(collectionName);
                const col = await db.collection(collectionName);
                await col.initPromise;
                const stats = await col.stats();
                const indexes = await col.getIndexes();
                console.log("--- Stats ---"); console.table([stats]);
                console.log("\n--- Indexes ---"); console.table(indexes.length > 0 ? indexes : [{ status: 'No indexes found' }]);
                break;
            }
            case 'list-indexes': {
                if (!collectionName) prettyError('Usage: list-indexes <collection>');
                await assertCollectionExists(collectionName);
                const col = await db.collection(collectionName);
                await col.initPromise;
                console.log(JSON.stringify(await col.getIndexes(), null, 2));
                break;
            }
            case 'export-collection': {
                if (!collectionName || !args[2]) prettyError('Usage: export-collection <collection> <file>');
                await assertCollectionExists(collectionName);
                const col = await db.collection(collectionName);
                await col.initPromise;
                const filename = args[2];
                const output = args.includes('--output') && args[args.indexOf('--output') + 1] === 'csv' ? 'csv' : 'json';
                if (output === 'csv') await col.exportCsv(filename);
                else await col.exportJson(filename);
                logger.log(`Collection "${collectionName}" exported to ${filename}`);
                break;
            }
            case 'doc-remove': {
                if (!collectionName || !args[2]) prettyError('Usage: doc-remove <collection> <docId>');
                await assertCollectionExists(collectionName);
                const col = await db.collection(collectionName);
                await col.initPromise;
                const success = await col.remove(args[2]);
                if (!success) prettyError(`Document "${args[2]}" not found.`);
                logger.log(`Document "${args[2]}" removed.`);
                break;
            }
            case 'drop-index': {
                if (!collectionName || !args[2]) prettyError('Usage: drop-index <collection> <field>');
                await assertCollectionExists(collectionName);
                const col = await db.collection(collectionName);
                await col.initPromise;
                await col.dropIndex(args[2]);
                logger.log(`Index on field "${args[2]}" dropped.`);
                break;
            }
            case 'collection-drop': {
                if (!collectionName) prettyError('Usage: collection-drop <collection>');
                await assertCollectionExists(collectionName);
                if (!(await confirmAction(`Are you sure you want to permanently delete collection "${collectionName}"?`))) {
                    logger.log('Operation cancelled.');
                } else {
                    const collectionPath = path.join(DB_PATH, collectionName);
                    await fsAsync.rm(collectionPath, { recursive: true, force: true });
                    logger.log(`Collection "${collectionName}" dropped.`);
                }
                break;
            }
            default:
                prettyError(`Unknown command: "${command}"`);
        }
    } finally {
        if (db) {
            await db.close();
        }
    }
}

run().catch(err => {
    prettyError(err.message);
});