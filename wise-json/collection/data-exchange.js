// wise-json/collection/data-exchange.js

const fs = require('fs/promises'); // Для асинхронной работы с файлами
// Утилита flattenDocToCsv теперь находится в collection/utils.js основного модуля
// Мы предполагаем, что она будет доступна через `this.flattenDocToCsv`
// или импортирована здесь, если она полностью независима.
// Для текущей структуры, где методы "подмешиваются" в Collection,
// и utils.js является частью основного модуля, мы можем ожидать, что
// flattenDocToCsv будет доступна как this.flattenDocToCsv, если она добавлена в прототип Collection,
// или мы можем импортировать ее здесь явно, если она экспортируется из utils.js.
// Давайте предположим, что она будет импортирована, если не является методом Collection.
// Однако, она используется в Collection.exportCsv в core.js, так что может быть уже там.
// Если нет, нужно будет ее импортировать:
// const { flattenDocToCsv } = require('./utils.js'); // Или из '../utils.js' если структура изменится
const logger = require('../logger');
/**
 * Экспортирует все "живые" документы коллекции в JSON-файл.
 * @param {string} filePath - Путь к файлу для экспорта.
 * @param {object} [options] - Опции (в данный момент не используются, но зарезервированы).
 * @returns {Promise<void>}
 * @throws {Error} если произошла ошибка записи файла.
 */
async function exportJson(filePath, options = {}) {
  // `this.getAll()` уже вызывает cleanupExpiredDocs и возвращает "живые" документы.
  const docs = await this.getAll();
  try {
    await fs.writeFile(filePath, JSON.stringify(docs, null, 2), 'utf8');
    // logger.log(`[Data Exchange] Exported ${docs.length} documents to ${filePath}`);
  } catch (error) {
    logger.error(`[Data Exchange] Error exporting JSON to ${filePath}:`, error);
    throw error; // Пробрасываем ошибку дальше
  }
}

/**
 * Экспортирует все "живые" документы коллекции в CSV-файл.
 * @param {string} filePath - Путь к файлу для экспорта.
 * @returns {Promise<void>}
 * @throws {Error} если произошла ошибка записи файла.
 */
async function exportCsv(filePath) {
  const docs = await this.getAll(); // Получаем "живые" документы

  if (docs.length === 0) {
    try {
      await fs.writeFile(filePath, '', 'utf8'); // Создаем пустой файл
      // logger.log(`[Data Exchange] No documents to export. Created empty CSV file: ${filePath}`);
    } catch (error) {
      logger.error(`[Data Exchange] Error creating empty CSV file ${filePath}:`, error);
      throw error;
    }
    return;
  }

  // Предполагаем, что flattenDocToCsv доступна.
  // Если она не метод `this`, ее нужно импортировать:
  // const { flattenDocToCsv } = require('./utils.js'); // или require('../utils') если она там
  // В текущей структуре core.js она импортируется и используется,
  // так что если data-exchange.js станет частью Collection, this.flattenDocToCsv может не существовать.
  // Безопаснее импортировать напрямую, если она не в прототипе Collection.
  // Давайте предположим, что она должна быть импортирована:
  const { flattenDocToCsv } = require('./utils.js'); // Путь может потребовать корректировки

  try {
    const csvData = flattenDocToCsv(docs);
    await fs.writeFile(filePath, csvData, 'utf8');
    // logger.log(`[Data Exchange] Exported ${docs.length} documents to ${filePath} (CSV)`);
  } catch (error) {
    logger.error(`[Data Exchange] Error exporting CSV to ${filePath}:`, error);
    throw error;
  }
}

/**
 * Импортирует документы из JSON-файла в коллекцию.
 * @param {string} filePath - Путь к JSON-файлу (должен содержать массив документов).
 * @param {object} [options] - Опции импорта.
 * @param {string} [options.mode='append'] - Режим импорта: 'append' (добавить) или 'replace' (заменить все).
 * @returns {Promise<void>}
 * @throws {Error} если файл не найден, невалидный JSON, или произошла ошибка вставки.
 */
async function importJson(filePath, options = {}) {
  const mode = options.mode || 'append'; // 'append' или 'replace'
  let jsonData;

  try {
    const rawData = await fs.readFile(filePath, 'utf8'); 
    jsonData = JSON.parse(rawData);
  } catch (error) {
    logger.error(`[Data Exchange] Error reading or parsing JSON file ${filePath}:`, error);
    throw error;
  }

  if (!Array.isArray(jsonData)) {
    const error = new Error('Import file must contain a JSON array of documents.');
    logger.error(`[Data Exchange] ${error.message}`);
    throw error;
  }

  if (jsonData.length === 0) {
    // logger.log('[Data Exchange] Import file is empty. No documents to import.');
    return; // Ничего не делаем, если массив пуст
  }

  try {
    if (mode === 'replace') {
      await this.clear(); // `this.clear()` - метод из crud-ops (или ops.js)
    }
    // `this.insertMany()` - метод из crud-ops (или ops.js)
    // Он должен корректно обработать пакетную вставку, включая проверки уникальности, если есть.
    const insertedDocs = await this.insertMany(jsonData);
    // logger.log(`[Data Exchange] Imported ${insertedDocs.length} documents from ${filePath} (mode: ${mode})`);
  } catch (error) {
    logger.error(`[Data Exchange] Error during import operation (mode: ${mode}):`, error);
    throw error;
  }
}

module.exports = {
  exportJson,
  exportCsv,
  importJson,
};