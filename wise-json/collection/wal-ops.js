// wise-json/collection/wal-ops.js

const fs = require('fs/promises');
const path = require('path');
const { isAlive } = require('./ttl.js');

/**
 * Преобразует операцию в строку для WAL.
 * @param {object} entry
 * @returns {string}
 */
function walEntryToString(entry) {
  return JSON.stringify(entry) + '\n';
}

/**
 * Читает записи из WAL файла.
 * @param {string} walFile
 * @param {string|null} sinceTimestamp
 * @returns {Promise<object[]>}
 */
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

/**
 * Создаёт функции для работы с WAL.
 * @param {object} params
 * @returns {object}
 */
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
  /**
   * Применяет запись WAL в память (документы и индексы).
   * @param {object} entry
   * @param {boolean} emit
   */
  function applyWalEntryToMemory(entry, emit = true) {
    if (entry.op === 'INSERT') {
      const doc = entry.doc;
      // ИЗМЕНЕНИЕ ЗДЕСЬ: Убрана проверка isAlive(doc) при применении INSERT из WAL в память.
      // Логика TTL должна применяться при чтении или через cleanupExpiredDocs,
      // а не при первоначальном добавлении в память из WAL.
      if (doc) { 
        documents.set(doc._id, doc);
        _updateIndexesAfterInsert && _updateIndexesAfterInsert(doc);
        if (emit) _emitter.emit('insert', doc);
      }
    } else if (entry.op === 'BATCH_INSERT') {
      const docs = Array.isArray(entry.docs) ? entry.docs : [];
      for (const doc of docs) {
        // Для BATCH_INSERT оставим проверку isAlive, так как это скорее "оптимизация",
        // чтобы не обрабатывать сразу мертвые документы из большого батча.
        // Или можно тоже убрать для полной консистентности с одиночным INSERT.
        // Пока оставим, так как тесты это не затрагивают напрямую.
        // Если убирать, то убрать `&& isAlive(doc)` и здесь.
        // Для большей консистентности - уберем.
        if (doc) { // Убрали isAlive(doc) и здесь
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
      if (prev) { // Не важно, isAlive или нет, если команда REMOVE пришла, удаляем
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

  /**
   * Записывает операцию в WAL, применяет в памяти, запускает checkpoint и возвращает результат.
   * Для batch insert и insert проверяет уникальность ДО записи и применения.
   * @param {object} entry
   * @param {string} opType
   * @param {function} getResult
   * @param {object} extra
   * @returns {Promise<any>}
   */
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
    
    let prev = null, // Эти переменные не используются в текущей логике getResult для INSERT/BATCH_INSERT
      next = null;
    if (opType === 'INSERT') {
      next = entry.doc;
    } else if (opType === 'BATCH_INSERT') {
      next = entry.docs;
    } else if (opType === 'UPDATE') {
      // prev здесь будет уже обновленным состоянием, если брать из documents.get()
      // getResult для UPDATE обычно ожидает обновленный документ
      if (documents.has(entry.id)) {
          const originalDoc = documents.get(entry.id); // Это уже обновленный документ
          next = originalDoc; // entry.data уже применено в applyWalEntryToMemory
          // prev для эмиттера событий берется внутри applyWalEntryToMemory до обновления
      } else {
          next = null;
      }
    } else if (opType === 'REMOVE') {
      // prev для эмиттера событий берется внутри applyWalEntryToMemory
      // getResult для REMOVE может вернуть boolean или удаленный документ (если он был в entry)
    }

    return getResult ? getResult(undefined, next) : undefined; // Для INSERT/BATCH_INSERT prev не имеет смысла тут
  }

  return {
    applyWalEntryToMemory,
    enqueueDataModification,
  };
}

module.exports = createWalOps;