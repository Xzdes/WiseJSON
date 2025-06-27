// index.js (root of the package)

// --- Основные классы и компоненты ---
const WiseJSON = require('./wise-json/index');
const CollectionClass = require('./wise-json/collection/core');

// --- Вспомогательные и продвинутые компоненты ---
const SyncManager = require('./wise-json/sync/sync-manager');
const apiClient   = require('./wise-json/sync/api-client');
const TransactionManager = require('./wise-json/collection/transaction-manager');
const logger      = require('./wise-json/logger');

// --- Импорт кастомных ошибок для экспорта ---
const {
    WiseJSONError,
    UniqueConstraintError,
    DocumentNotFoundError,
    ConfigurationError
} = require('./wise-json/errors.js');


/**
 * Фабричная функция для создания экземпляра WiseJSON.
 * Является рекомендуемой точкой входа для большинства пользователей.
 * @param {string} dbRootPath - Путь к корневой директории базы данных.
 * @param {object} [options] - Опции конфигурации.
 * @returns {WiseJSON} Новый экземпляр WiseJSON.
 */
function connect(dbRootPath, options) {
  const db = new WiseJSON(dbRootPath, options);
  // `init()` теперь вызывается "лениво" при первом обращении к данным,
  // поэтому пользователю не нужно вызывать его явно.
  return db;
}

// ===========================================
// --- Публичный API пакета ---
// ===========================================
module.exports = {
  // --- Основные ---
  WiseJSON,
  connect,
  Collection: CollectionClass,

  // --- Кастомные ошибки (для `try...catch`) ---
  WiseJSONError,
  UniqueConstraintError,
  DocumentNotFoundError,
  ConfigurationError,
  
  // --- Продвинутые компоненты и утилиты ---
  SyncManager,
  apiClient,
  TransactionManager,
  logger,

  // Экспорт низкоуровневых компонентов (для расширенных сценариев или тестов)
  // Эти компоненты могут быть не так интересны обычному пользователю.
  WALManager: require('./wise-json/wal-manager'),
  CheckpointManager: require('./wise-json/checkpoint-manager'),
  Document: require('./wise-json/collection/core').Document, // Если есть экспорт Document
};