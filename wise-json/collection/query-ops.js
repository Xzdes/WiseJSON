// wise-json/collection/query-ops.js

const { cleanupExpiredDocs, isAlive } = require('./ttl.js');
const { matchFilter } = require('./utils.js');
const logger = require('../logger');

/**
 * Получает документ по его ID.
 * @param {string} id - ID документа.
 * @returns {Promise<object|null>} - Документ или null, если не найден или истек срок жизни.
 */
async function getById(id) {
  const doc = this.documents.get(id);
  return doc && isAlive(doc) ? doc : null;
}

/**
 * Получает все "живые" документы из коллекции.
 * Перед возвратом удаляет все истекшие документы.
 * @returns {Promise<Array<object>>} - Массив всех "живых" документов.
 */
async function getAll() {
  cleanupExpiredDocs(this.documents, this._indexManager);
  return Array.from(this.documents.values());
}

/**
 * Подсчитывает количество "живых" документов в коллекции.
 * Перед подсчетом удаляет все истекшие документы.
 * @returns {Promise<number>} - Количество "живых" документов.
 */
async function count() {
  cleanupExpiredDocs(this.documents, this._indexManager);
  return this.documents.size;
}

/**
 * Находит документы, соответствующие переданному запросу (функции или объекту).
 * @param {function|object} query - Функция-предикат `(doc) => boolean` или объект-фильтр.
 * @returns {Promise<Array<object>>} - Массив найденных "живых" документов.
 * @throws {Error} если query не является функцией или объектом.
 */
async function find(query) {
  if (typeof query === 'function') {
    cleanupExpiredDocs(this.documents, this._indexManager);
    return Array.from(this.documents.values()).filter(query);
  }

  if (typeof query === 'object' && query !== null) {
    cleanupExpiredDocs(this.documents, this._indexManager);

    let initialDocIds = null;
    for (const fieldName in query) {
      if (typeof query[fieldName] !== 'object' && this._indexManager.indexes.has(fieldName)) {
        const index = this._indexManager.indexes.get(fieldName);
        const value = query[fieldName];

        if (index.type === 'unique') {
          const id = this._indexManager.findOneIdByIndex(fieldName, value);
          initialDocIds = id ? new Set([id]) : new Set();
        } else {
          initialDocIds = this._indexManager.findIdsByIndex(fieldName, value);
        }
        break;
      }
    }

    const results = [];
    const sourceIterator = initialDocIds !== null
      ? Array.from(initialDocIds).map(id => this.documents.get(id))
      : this.documents.values();

    for (const doc of sourceIterator) {
      if (doc && isAlive(doc) && matchFilter(doc, query)) {
        results.push(doc);
      }
    }
    return results;
  }

  throw new Error('find: аргумент должен быть функцией или объектом-фильтром.');
}

/**
 * Находит первый документ, соответствующий переданному запросу.
 * @param {function|object} query - Функция-предикат или объект-фильтр.
 * @returns {Promise<object|null>} - Найденный "живой" документ или null.
 * @throws {Error} если query не является функцией или объектом.
 */
async function findOne(query) {
  if (typeof query === 'function') {
    cleanupExpiredDocs(this.documents, this._indexManager);
    for (const doc of this.documents.values()) {
        if (isAlive(doc) && query(doc)) {
            return doc;
        }
    }
    return null;
  }

  if (typeof query === 'object' && query !== null) {
    cleanupExpiredDocs(this.documents, this._indexManager);

    for (const doc of this.documents.values()) {
      if (isAlive(doc) && matchFilter(doc, query)) {
        return doc;
      }
    }
    return null;
  }

  throw new Error('findOne: аргумент должен быть функцией или объектом-фильтром.');
}

/**
 * Находит документы по значению индексированного поля.
 * @param {string} fieldName - Имя индексированного поля.
 * @param {any} value - Значение для поиска.
 * @returns {Promise<Array<object>>} - Массив найденных "живых" документов.
 */
async function findByIndexedValue(fieldName, value) {
  cleanupExpiredDocs(this.documents, this._indexManager);

  const index = this._indexManager.indexes.get(fieldName);
  if (!index) {
    return [];
  }

  let idsToFetch = new Set();
  if (index.type === 'unique') {
    const id = this._indexManager.findOneIdByIndex(fieldName, value);
    if (id) {
      idsToFetch.add(id);
    }
  } else {
    idsToFetch = this._indexManager.findIdsByIndex(fieldName, value);
  }

  const result = [];
  for (const id of idsToFetch) {
    const doc = this.documents.get(id);
    if (doc && isAlive(doc)) {
      result.push(doc);
    }
  }
  return result;
}

/**
 * Находит один документ по значению индексированного поля.
 * @param {string} fieldName - Имя индексированного поля.
 * @param {any} value - Значение для поиска.
 * @returns {Promise<object|null>} - Найденный "живой" документ или null.
 */
async function findOneByIndexedValue(fieldName, value) {
  const index = this._indexManager.indexes.get(fieldName);
  if (!index) {
    return null;
  }

  if (index.type === 'unique') {
    const id = this._indexManager.findOneIdByIndex(fieldName, value);
    if (id) {
      const doc = this.documents.get(id);
      if (doc && isAlive(doc)) {
        return doc;
      }
    }
  } else {
    const results = await this.findByIndexedValue(fieldName, value);
    if (results.length > 0) {
      return results[0];
    }
  }
  return null;
}

module.exports = {
  getById,
  getAll,
  count,
  find,
  findOne,
  findByIndexedValue,
  findOneByIndexedValue,
};