// wise-json/collection/query-ops.js

const { cleanupExpiredDocs, isAlive } = require('./ttl.js'); // Предполагаем, что ttl.js в той же директории

/**
 * Получает документ по его ID.
 * @param {string} id - ID документа.
 * @returns {Promise<object|null>} - Документ или null, если не найден или истек срок жизни.
 */
async function getById(id) {
  // this.documents - это Map в экземпляре Collection
  // this._indexManager - экземпляр IndexManager (здесь не используется напрямую, но мог бы)
  // cleanupExpiredDocs и isAlive импортированы
  
  // Хотя cleanupExpiredDocs вызывается во многих операциях чтения,
  // для getById это может быть избыточным, если документ получается напрямую по ключу.
  // Однако, чтобы быть консистентным с другими методами и гарантировать,
  // что не вернется "мертвый" документ, который еще не был удален таймером,
  // можно либо положиться на проверку isAlive, либо очистить только этот документ, если он есть.
  // Просто проверка isAlive эффективнее для одного документа.

  const doc = this.documents.get(id);
  return doc && isAlive(doc) ? doc : null;
}

/**
 * Получает все "живые" документы из коллекции.
 * Перед возвратом удаляет все истекшие документы.
 * @returns {Promise<Array<object>>} - Массив всех "живых" документов.
 */
async function getAll() {
  // this.options - опции коллекции
  // this._indexManager - для передачи в cleanupExpiredDocs
  cleanupExpiredDocs(this.documents, this._indexManager);
  return Array.from(this.documents.values()).filter(doc => isAlive(doc)); // Дополнительный filter(isAlive) для гарантии
}

/**
 * Подсчитывает количество "живых" документов в коллекции.
 * Перед подсчетом удаляет все истекшие документы.
 * @returns {Promise<number>} - Количество "живых" документов.
 */
async function count() {
  cleanupExpiredDocs(this.documents, this._indexManager);
  // После cleanupExpiredDocs, все документы в this.documents должны быть isAlive() === true
  // Однако, чтобы быть абсолютно уверенным, можно оставить filter(isAlive) или просто вернуть this.documents.size
  // Если cleanupExpiredDocs работает идеально, то return this.documents.size; будет быстрее.
  // Для надежности оставим filter, это не сильно скажется на производительности count.
  return Array.from(this.documents.values()).filter(doc => isAlive(doc)).length;
}

/**
 * Находит документы, соответствующие переданной функции-предикату.
 * Перед поиском удаляет все истекшие документы.
 * @param {function} queryFn - Функция-предикат `(doc) => boolean`.
 * @returns {Promise<Array<object>>} - Массив найденных "живых" документов.
 * @throws {Error} если queryFn не является функцией.
 */
async function find(queryFn) {
  if (typeof queryFn !== 'function') {
    throw new Error('find: queryFn должен быть функцией.');
  }
  cleanupExpiredDocs(this.documents, this._indexManager);
  return Array.from(this.documents.values())
    .filter(doc => isAlive(doc)) // Сначала убедимся, что документ жив
    .filter(queryFn);           // Затем применяем пользовательский фильтр
}

/**
 * Находит первый документ, соответствующий переданной функции-предикату.
 * Перед поиском удаляет все истекшие документы.
 * @param {function} queryFn - Функция-предикат `(doc) => boolean`.
 * @returns {Promise<object|null>} - Найденный "живой" документ или null.
 * @throws {Error} если queryFn не является функцией.
 */
async function findOne(queryFn) {
  if (typeof queryFn !== 'function') {
    throw new Error('findOne: queryFn должен быть функцией.');
  }
  cleanupExpiredDocs(this.documents, this._indexManager);
  // Array.prototype.find уже достаточно эффективен
  return Array.from(this.documents.values())
    .filter(doc => isAlive(doc)) // Фильтруем живые перед поиском
    .find(queryFn) || null;      // Применяем пользовательский фильтр
}

/**
 * Находит документы по значению индексированного поля.
 * Перед поиском удаляет все истекшие документы.
 * @param {string} fieldName - Имя индексированного поля.
 * @param {any} value - Значение для поиска.
 * @returns {Promise<Array<object>>} - Массив найденных "живых" документов.
 */
async function findByIndexedValue(fieldName, value) {
  cleanupExpiredDocs(this.documents, this._indexManager);
  
  const index = this._indexManager.indexes.get(fieldName);
  if (!index) {
    // Если индекса нет, можно либо вернуть пустой массив, либо упасть с ошибкой,
    // либо выполнить полный перебор (что медленно и не ожидается от findByIndexedValue).
    // Возврат пустого массива - наиболее безопасное поведение.
    // console.warn(`[Query Ops] Попытка поиска по несуществующему индексу: ${fieldName}`);
    return [];
  }

  let idsToFetch = new Set();
  if (index.type === 'unique') {
    const id = this._indexManager.findOneIdByIndex(fieldName, value);
    if (id) {
      idsToFetch.add(id);
    }
  } else { // 'standard'
    const ids = this._indexManager.findIdsByIndex(fieldName, value);
    idsToFetch = ids; // ids уже Set
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
 * Находит один документ по значению индексированного поля (предпочтительно уникального).
 * Перед поиском удаляет все истекшие документы.
 * @param {string} fieldName - Имя индексированного поля.
 * @param {any} value - Значение для поиска.
 * @returns {Promise<object|null>} - Найденный "живой" документ или null.
 */
async function findOneByIndexedValue(fieldName, value) {
  // cleanupExpiredDocs будет вызван внутри findByIndexedValue, если мы его вызовем.
  // Но для findOne можно сделать чуть эффективнее, если индекс уникальный.

  const index = this._indexManager.indexes.get(fieldName);
  if (!index) {
    return null;
  }
  
  let doc = null;
  if (index.type === 'unique') {
    const id = this._indexManager.findOneIdByIndex(fieldName, value);
    if (id) {
      const potentialDoc = this.documents.get(id);
      if (potentialDoc && isAlive(potentialDoc)) {
        // Если документ "мертв", но еще не удален из this.documents,
        // мы его не вернем. Нужно ли здесь вызывать cleanupExpiredDocs для этого одного документа?
        // Проще проверить isAlive.
        doc = potentialDoc;
      } else if (potentialDoc && !isAlive(potentialDoc)) {
        // Документ "мертв", его нужно бы удалить.
        // Вызов cleanupExpiredDocs(new Map([[id, potentialDoc]]), this._indexManager) был бы локальной очисткой.
        // Но это усложнение. isAlive() уже не вернет его.
      }
    }
  } else {
    // Для неуникального индекса, findByIndexedValue вернет массив. Возьмем первый.
    const results = await this.findByIndexedValue(fieldName, value); // findByIndexedValue уже делает cleanup
    if (results.length > 0) {
      doc = results[0];
    }
  }
  return doc;
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