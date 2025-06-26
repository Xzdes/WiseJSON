// index.js (root of the package)

const WiseJSON = require('./wise-json/index');
const SyncManager = require('./wise-json/sync/sync-manager');
const apiClient   = require('./wise-json/sync/api-client');
const logger      = require('./wise-json/logger');
const WALManager  = require('./wise-json/wal-manager');
const CheckpointManager = require('./wise-json/checkpoint-manager');
const TransactionManager = require('./wise-json/collection/transaction-manager');
const CollectionClass = require('./wise-json/collection/core');
const DocumentClass   = require('./wise-json/collection/core').Document;

// connect() НЕ должен быть асинхронным. Он просто создает обертку.
function connect(dbRootPath, options) {
  const db = new WiseJSON(dbRootPath, options);
  return db; // Возвращаем обычный экземпляр.
}

// Экспорт публичного API
module.exports = {
  WiseJSON,
  connect, // Пользователь сам будет решать, как ему удобнее работать.
  Collection: CollectionClass,
  Document: DocumentClass,
  SyncManager,
  apiClient,
  WALManager,
  CheckpointManager,
  TransactionManager,
  logger,
};