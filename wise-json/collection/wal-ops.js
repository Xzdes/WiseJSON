// wise-json/collection/wal-ops.js

const fs = require('fs/promises');
const path = require('path');
const { isAlive } = require('./ttl.js');

function walEntryToString(entry) {
  return JSON.stringify(entry) + '\n';
}

async function readWalEntries(walFile, sinceTimestamp = null) {
  try {
    const raw = await fs.readFile(walFile, 'utf8');
    const lines = raw.trim().split('\n');
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        entries.push(entry);
      } catch {
        // игнорируем ошибочные строки
      }
    }
    return entries;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function readWal(collection) {
  if (!collection) {
    throw new Error('[readWal] В функцию передан undefined/null вместо коллекции. Проверь вызов readWal(this.collection) внутри sync-manager.');
  }
  let walPath = null;
  if (collection._walPath) walPath = collection._walPath;
  else if (collection.walPath) walPath = collection.walPath;
  else if (collection._wal && collection._wal.path) walPath = collection._wal.path;
  else if (collection._wal && collection._wal.walPath) walPath = collection._wal.walPath;

  if (!walPath) {
    throw new Error(
      '[readWal] Не удалось определить путь к WAL-файлу коллекции. ' +
      'Проверь свойства collection._walPath, collection.walPath, collection._wal.path. ' +
      `Объект collection: ${JSON.stringify(collection, null, 2)}`
    );
  }
  return readWalEntries(walPath, null);
}

function createWalOps({
  documents,
  indexManager,
  _performCheckpoint,
  _emitter,
  _updateIndexesAfterInsert,
  _updateIndexesAfterRemove,
  _updateIndexesAfterUpdate,
  _triggerCheckpointIfRequired,
  options,
  walPath,
}) {
  function applyWalEntryToMemory(entry, emit = true) {
    if (entry.op === 'INSERT') {
      const doc = entry.doc;
      if (doc) { 
        documents.set(doc._id, doc);
        _updateIndexesAfterInsert && _updateIndexesAfterInsert(doc);
        if (emit) _emitter.emit('insert', doc);
      }
    } else if (entry.op === 'BATCH_INSERT') {
      const docs = Array.isArray(entry.docs) ? entry.docs : [];
      for (const doc of docs) {
        if (doc) {
          documents.set(doc._id, doc);
          _updateIndexesAfterInsert && _updateIndexesAfterInsert(doc);
          if (emit) _emitter.emit('insert', doc);
        }
      }
    } else if (entry.op === 'UPDATE') {
      const id = entry.id;
      const prev = documents.get(id); 
      if (prev && isAlive(prev)) { 
        const updated = { ...prev, ...entry.data };
        documents.set(id, updated);
        _updateIndexesAfterUpdate && _updateIndexesAfterUpdate(prev, updated);
        if (emit) _emitter.emit('update', updated, prev);
      } else if (!prev && entry.data && entry.data._id === id) { 
        // Логика для случая, если документ не найден (например, upsert не поддерживается)
      }
    } else if (entry.op === 'REMOVE') {
      const id = entry.id;
      const prev = documents.get(id);
      if (prev) {
        documents.delete(id);
        _updateIndexesAfterRemove && _updateIndexesAfterRemove(prev);
        if (emit) _emitter.emit('remove', prev);
      }
    } else if (entry.op === 'CLEAR') {
      const docsToRemove = Array.from(documents.values());
      documents.clear(); 
      if (_updateIndexesAfterRemove) {
        for (const doc of docsToRemove) {
          _updateIndexesAfterRemove(doc); 
        }
      }
      if (emit) _emitter.emit('clear');
    }
  }

  async function enqueueDataModification(entry, opType, getResult, extra = {}) {
    if (opType === 'INSERT') {
      const docToInsert = entry.doc;
      if (docToInsert && indexManager) { 
        const uniqueIndexesMeta = (indexManager.getIndexesMeta() || []).filter(m => m.type === 'unique');
        for (const idxMeta of uniqueIndexesMeta) {
          const fieldName = idxMeta.fieldName;
          const valueToInsert = docToInsert[fieldName];
          if (valueToInsert !== undefined && valueToInsert !== null) {
            const index = indexManager.indexes.get(fieldName);
            if (index && index.data && index.data.has(valueToInsert)) {
              if (index.data.get(valueToInsert) !== docToInsert._id) {
                throw new Error(
                  `Duplicate value '${valueToInsert}' for unique index '${fieldName}' in insert operation`
                );
              }
            }
          }
        }
      }
    }
    else if (opType === 'BATCH_INSERT') {
      const docs = entry.docs || [];
      if (docs.length > 0 && indexManager) { 
        const uniqueIndexesMeta = (indexManager.getIndexesMeta() || [])
          .filter(meta => meta.type === 'unique')
          .map(meta => meta.fieldName);

        for (const field of uniqueIndexesMeta) {
          const batchValues = new Set();
          const existingValuesFromMemory = new Set();
          for (const doc of documents.values()) {
              if (doc[field] !== undefined && doc[field] !== null) {
                existingValuesFromMemory.add(doc[field]);
              }
          }

          for (const doc of docs) {
            if (doc[field] !== undefined && doc[field] !== null) {
              if (batchValues.has(doc[field]) || existingValuesFromMemory.has(doc[field])) {
                throw new Error(
                  `Duplicate value '${doc[field]}' for unique index '${field}' in batch insert`
                );
              }
              batchValues.add(doc[field]);
            }
          }
        }
      }
    }

    await fs.mkdir(path.dirname(walPath), { recursive: true });
    await fs.appendFile(walPath, walEntryToString(entry), 'utf8');

    applyWalEntryToMemory(entry, true); 

    if (typeof _triggerCheckpointIfRequired === 'function') {
      _triggerCheckpointIfRequired(entry); 
    }
    
    let prev = null, next = null;
    if (opType === 'INSERT') {
      next = entry.doc;
    } else if (opType === 'BATCH_INSERT') {
      next = entry.docs;
    } else if (opType === 'UPDATE') {
      if (documents.has(entry.id)) {
          const originalDoc = documents.get(entry.id);
          next = originalDoc;
      } else {
          next = null;
      }
    } else if (opType === 'REMOVE') {
      // prev для эмиттера событий берется внутри applyWalEntryToMemory
    }

    return getResult ? getResult(undefined, next) : undefined;
  }

  return {
    applyWalEntryToMemory,
    enqueueDataModification,
  };
}

module.exports = createWalOps;
module.exports.readWal = readWal;
