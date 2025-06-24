// index.js (root of the package)

/**
 * Точка входа для Node.js: единый экспорт всех публичных классов и функций.
 * Клиент может сделать:
 *   const { connect, Collection, SyncManager } = require('wise-json-db');
 */

const WiseJSON = require('./wise-json/index');
const SyncManager = require('./wise-json/sync/sync-manager');
const apiClient   = require('./wise-json/sync/api-client');
const logger      = require('./wise-json/logger');
const WALManager  = require('./wise-json/wal-manager');
const CheckpointManager = require('./wise-json/checkpoint-manager');
const TransactionManager = require('./wise-json/collection/transaction-manager');

// Прямая ссылка на класс Collection из ядра (синхронный вызов конструктора)
const CollectionClass = require('./wise-json/collection/core');
const DocumentClass   = require('./wise-json/collection/core').Document;

/**
 * connect(dbRootPath, options) → WiseJSON instance
 *
 * Создаёт новый экземпляр WiseJSON и заменяет его метод .collection(name)
 * чтобы возвращать синхронно новую коллекцию с Mongo‑подобными методами.
 */
function connect(dbRootPath, options) {
  const db = new WiseJSON(dbRootPath, options);

  // Синхронная .collection
  db.collection = function(name) {
    // Создаём новый экземпляр коллекции без асинхронности
    const col = new CollectionClass(name, db.dbRootPath, db.options);

    // alias insertOne/insertMany
    col.insertOne = col.insert.bind(col);
    if (typeof col.insertMany === 'function') {
      col.insertMany = col.insertMany.bind(col);
    }

    // alias updateOne/updateMany
    if (typeof col.updateOne === 'function') {
      col.updateOne = col.updateOne.bind(col);
    }
    if (typeof col.updateMany === 'function') {
      col.updateMany = col.updateMany.bind(col);
    }

    // alias deleteOne/deleteMany
    col.deleteOne = col.remove.bind(col);
    if (typeof col.removeMany === 'function') {
      col.deleteMany = col.removeMany.bind(col);
    } else {
      col.deleteMany = col.remove.bind(col);
    }

    // alias find/findOne
    if (typeof col.find === 'function') {
      col.find = col.find.bind(col);
    }
    if (typeof col.findOne === 'function') {
      col.findOne = col.findOne.bind(col);
    }

    return col;
  };

  return db;
}

// Экспорт публичного API
module.exports = {
  WiseJSON,
  connect,
  Collection: CollectionClass,
  Document: DocumentClass,
  SyncManager,
  apiClient,
  WALManager,
  CheckpointManager,
  TransactionManager,
  logger,
};
