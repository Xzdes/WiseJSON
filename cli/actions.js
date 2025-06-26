// cli/actions.js

const fs = require('fs/promises');
const path = require('path');
const { flattenDocToCsv } = require('../wise-json/collection/utils.js');
const { confirmAction, prettyError } = require('./utils.js');

// --- Утилита для проверки существования коллекции ---
async function assertCollectionExists(db, collectionName) {
    const names = await db.getCollectionNames();
    if (!names.includes(collectionName)) {
        prettyError(`Collection "${collectionName}" does not exist.`);
    }
}

// --- Read-Only Actions ---

async function listCollectionsAction(db) {
  const collections = await db.getCollectionNames();
  const result = await Promise.all(collections.map(async (name) => {
    const col = await db.collection(name);
    await col.initPromise;
    return { name, count: await col.count() };
  }));
  if (result.length === 0) {
      console.log('No collections found.');
      return;
  }
  console.table(result);
}

async function showCollectionAction(db, [collectionName], options) {
  if (!collectionName) prettyError('Usage: show-collection <collection> [options]');
  await assertCollectionExists(db, collectionName);
  
  const col = await db.collection(collectionName);
  await col.initPromise;
  
  const limit = parseInt(options.limit || '10', 10);
  const offset = parseInt(options.offset || '0', 10);
  const sortField = options.sort;
  const sortOrder = options.order || 'asc';
  const output = options.output || 'json';
  
  let filter = {};
  if (options.filter) {
      try {
          filter = JSON.parse(options.filter);
      } catch (e) {
          prettyError(`Invalid JSON in --filter option: ${e.message}`);
      }
  }

  let docs = await col.find(filter);
  
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
  
  if (output === 'csv') console.log(flattenDocToCsv(docs));
  else if (output === 'table') console.table(docs);
  else console.log(JSON.stringify(docs, null, 2));
}

async function listIndexesAction(db, [collectionName]) {
    if (!collectionName) prettyError('Usage: list-indexes <collection>');
    await assertCollectionExists(db, collectionName);
    const col = await db.collection(collectionName);
    await col.initPromise;
    console.log(JSON.stringify(await col.getIndexes(), null, 2));
}

async function getDocumentAction(db, [collectionName, docId]) {
    if (!collectionName || !docId) prettyError('Usage: get-document <collection> <docId>');
    await assertCollectionExists(db, collectionName);
    const col = await db.collection(collectionName);
    await col.initPromise;
    const doc = await col.getById(docId);
    if (!doc) {
        prettyError(`Document with ID "${docId}" not found in collection "${collectionName}".`);
    }
    console.log(JSON.stringify(doc, null, 2));
}

// --- Write Actions ---

async function createIndexAction(db, [collectionName, fieldName], options) {
  if (!collectionName || !fieldName) prettyError('Usage: create-index <collection> <field> [--unique]');
  const col = await db.collection(collectionName);
  await col.initPromise;
  await col.createIndex(fieldName, { unique: !!options.unique });
  console.log(`Index on "${fieldName}" created successfully in collection "${collectionName}".`);
}

async function dropIndexAction(db, [collectionName, fieldName]) {
    if (!collectionName || !fieldName) prettyError('Usage: drop-index <collection> <field>');
    await assertCollectionExists(db, collectionName);
    const col = await db.collection(collectionName);
    await col.initPromise;
    await col.dropIndex(fieldName);
    console.log(`Index on "${fieldName}" dropped from collection "${collectionName}".`);
}

async function importCollectionAction(db, [collectionName, filePath], options) {
  if (!collectionName || !filePath) prettyError('Usage: import-collection <collection> <file.json> [--mode=replace|append]');
  
  const col = await db.collection(collectionName);
  await col.initPromise;
  
  const mode = options.mode || 'append';
  const absoluteFilePath = path.resolve(process.cwd(), filePath);

  try {
      await col.importJson(absoluteFilePath, { mode });
      console.log(`Import to "${collectionName}" from ${absoluteFilePath} completed (mode: ${mode}).`);
  } catch(e) {
      prettyError(`Failed to import from file: ${e.message}`);
  }
}

async function dropCollectionAction(db, [collectionName], options) {
    if (!collectionName) prettyError('Usage: collection-drop <collection>');
    await assertCollectionExists(db, collectionName);
    
    const confirmed = await confirmAction(`Are you sure you want to PERMANENTLY delete the collection "${collectionName}"?`, options);
    
    if (confirmed) {
        const collectionPath = path.join(db.dbRootPath, collectionName);
        await fs.rm(collectionPath, { recursive: true, force: true });
        console.log(`Collection "${collectionName}" dropped successfully.`);
    } else {
        console.log('Operation cancelled.');
    }
}

// --- Реестр команд ---
module.exports = {
  'list-collections': { handler: listCollectionsAction, isWrite: false, description: 'Lists all collections and their document counts.' },
  'show-collection':  { handler: showCollectionAction,  isWrite: false, description: 'Shows documents in a collection with pagination and filtering.' },
  'list-indexes':     { handler: listIndexesAction,     isWrite: false, description: 'Lists indexes for a collection.'},
  'get-document':     { handler: getDocumentAction,     isWrite: false, description: 'Gets a single document by its ID.'},

  'create-index':     { handler: createIndexAction,     isWrite: true, description: 'Creates an index on a field. Use --unique for a unique index.' },
  'drop-index':       { handler: dropIndexAction,       isWrite: true, description: 'Drops an index from a collection.' },
  'import-collection':{ handler: importCollectionAction,isWrite: true, description: 'Imports documents from a JSON file. Use --mode=replace to clear first.' },
  'collection-drop':  { handler: dropCollectionAction,  isWrite: true, description: 'Permanently deletes an entire collection. Use with caution.' },
};