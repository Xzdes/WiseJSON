// wise-json/collection/ops.js

/**
 * Основные операции коллекции WiseJSON.
 * Все методы асинхронные и используют очередь с блокировкой.
 */
const { isAlive } = require('./ttl.js'); 
const logger = require('../logger');
/**
 * Вставляет один документ.
 * @param {object} doc - Документ для вставки.
 * @returns {Promise<object>} - Вставленный документ с присвоенным _id и временными метками.
 * @throws {Error} если `doc` не является объектом или возникает ошибка при вставке (например, нарушение уникального индекса).
 */
async function insert(doc) {
  // `this.isPlainObject` должно быть доступно из экземпляра Collection
  if (!this.isPlainObject(doc)) {
    throw new Error('insert: аргумент должен быть объектом.');
  }
  // `this._enqueue` - метод из queue.js, привязанный к экземпляру Collection
  return this._enqueue(async () => {
    const _id = doc._id || this._idGenerator(); // `this._idGenerator` из Collection
    const now = new Date().toISOString();
    const finalDoc = {
      ...doc,
      _id,
      createdAt: doc.createdAt || now,
      updatedAt: now,
    };
    // `this._enqueueDataModification` - метод из Collection (ранее wal-ops.js)
    const result = await this._enqueueDataModification(
      { op: 'INSERT', doc: finalDoc },
      'INSERT',
      (_prev, insertedDoc) => insertedDoc // getResult функция
    );
    this._stats.inserts++; // `this._stats` из Collection
    return result;
  });
}

/**
 * Вставляет массив документов.
 * Если при вставке одного из документов возникает ошибка (например, нарушение уникального индекса),
 * вся операция считается неуспешной, и ошибка выбрасывается (транзакционность на уровне батча).
 * @param {Array<object>} docs - Массив документов для вставки.
 * @returns {Promise<Array<object>>} - Массив вставленных документов.
 * @throws {Error} если `docs` не является массивом или возникает ошибка при вставке.
 */
async function insertMany(docs) {
  if (!Array.isArray(docs)) {
    throw new Error('insertMany: аргумент должен быть массивом.');
  }
  if (docs.length === 0) {
    return []; // Ничего не делать, если массив пуст
  }
  const now = new Date().toISOString();

  return this._enqueue(async () => {
    // _acquireLock и _releaseLockIfHeld - методы экземпляра Collection
    await this._acquireLock(); 
    try {
      const preparedDocs = docs.map(doc => ({
        ...doc,
        _id: doc._id || this._idGenerator(),
        createdAt: doc.createdAt || now,
        updatedAt: now,
      }));

      // _enqueueDataModification для BATCH_INSERT уже содержит предварительную проверку уникальности
      // для всего батча перед записью в WAL.
      const result = await this._enqueueDataModification(
        { op: 'BATCH_INSERT', docs: preparedDocs },
        'BATCH_INSERT',
        (_prev, insertedDocs) => insertedDocs
      );

      this._stats.inserts += result.length; // result должен быть массивом вставленных документов
      return result;
    } finally {
      await this._releaseLockIfHeld();
    }
  });
}

/**
 * Обновляет один документ по его ID.
 * @param {string} id - ID документа для обновления.
 * @param {object} updates - Объект с полями для обновления.
 * @returns {Promise<object|null>} - Обновленный документ или null, если документ не найден.
 * @throws {Error} если `updates` не является объектом или возникает ошибка при обновлении (например, нарушение уникального индекса).
 */
async function update(id, updates) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('update: id должен быть непустой строкой.');
  }
  // `this.isPlainObject` из Collection
  if (!this.isPlainObject(updates)) {
    throw new Error('update: обновления должны быть объектом.');
  }
  
  // Проверка существования документа до постановки в очередь может быть полезна,
  // но основная проверка и операция должны быть внутри _enqueue для атомарности.
  // if (!this.documents.has(id)) { // this.documents из Collection
  //   // Можно либо выбросить ошибку здесь, либо вернуть null/false из _enqueueDataModification
  //   // Текущая логика _enqueueDataModification/applyWalEntryToMemory для UPDATE ничего не делает, если документ не найден.
  //   // Для консистентности, если документ не найден, update должен вернуть null или ошибку.
  //   // Оставим как есть, applyWalEntryToMemory вернет null, если prev не найден.
  // }

  return this._enqueue(async () => {
    // Повторная проверка существования внутри критической секции
    if (!this.documents.has(id)) {
      // logger.warn(`[Ops] Update: Document with id "${id}" not found.`);
      return null; // Или выбросить ошибку, если это предпочтительнее
    }
    const now = new Date().toISOString();
    const result = await this._enqueueDataModification(
      { op: 'UPDATE', id, data: { ...updates, updatedAt: now } },
      'UPDATE',
      (_prev, updatedDoc) => updatedDoc, // getResult
      { idToUpdate: id } // extra, если _enqueueDataModification его использует для получения prevDoc
    );
    // result может быть null, если applyWalEntryToMemory не нашел документ (маловероятно после проверки выше)
    // или если isAlive(prev) было false.
    if (result) { // Только если документ был успешно обновлен
        this._stats.updates++;
    }
    return result;
  });
}

/**
 * Обновляет несколько документов, соответствующих предикату.
 * Если при обновлении одного из документов возникает ошибка (например, нарушение уникального индекса),
 * операция `updateMany` прерывается, и ошибка выбрасывается дальше.
 * @param {function} queryFn - Синхронная функция-предикат `(doc) => boolean`.
 * @param {object} updates - Объект с обновлениями.
 * @returns {Promise<number>} - Количество успешно обновленных документов ДО возникновения ошибки.
 * @throws {Error} если `queryFn` не функция, `updates` не объект, или возникает ошибка при обновлении одного из документов.
 */
async function updateMany(queryFn, updates) {
  if (typeof queryFn !== 'function') {
    throw new Error('updateMany: queryFn должен быть функцией.');
  }
  if (!this.isPlainObject(updates)) { // `this.isPlainObject` из Collection
    throw new Error('updateMany: обновления должны быть объектом.');
  }

  // Собираем ID документов для обновления ДО начала реальных операций,
  // чтобы избежать проблем с модификацией коллекции во время итерации.
  const idsToUpdate = [];
  // `this.documents` и `isAlive` (используемый в `this.find` или `this.getAll`)
  // должны быть доступны из экземпляра Collection.
  // Проще итерировать `this.documents` напрямую, если `queryFn` синхронный.
  for (const [id, doc] of this.documents.entries()) {
      if (isAlive(doc) && queryFn(doc)) { // Убедимся, что документ "жив" перед применением предиката
          idsToUpdate.push(id);
      }
  }

  if (idsToUpdate.length === 0) {
    return 0; // Ничего не обновляем
  }

  let successfullyUpdatedCount = 0;
  // Каждая операция `this.update` будет поставлена в очередь и выполнена последовательно.
  for (const id of idsToUpdate) {
    try {
      const updatedDoc = await this.update(id, updates); // `this.update` определен выше
      if (updatedDoc) { // Учитываем только успешные обновления (update может вернуть null)
            successfullyUpdatedCount++;
      }
    } catch (error) {
      // Если this.update() выбросил ошибку (например, нарушение уникальности),
      // перевыбрасываем ее, чтобы прервать updateMany и сообщить вызывающей стороне.
      // logger.error(`[Ops] Error updating document ${id} in updateMany. Aborting. Error: ${error.message}`);
      throw error; 
    }
  }
  return successfullyUpdatedCount;
}

/**
 * Удаляет один документ по его ID.
 * @param {string} id - ID документа для удаления.
 * @returns {Promise<boolean>} - `true`, если документ был найден и успешно удален, иначе `false`.
 * @throws {Error} если возникает ошибка при удалении.
 */
async function remove(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('remove: id должен быть непустой строкой.');
  }
  
  // Предварительная проверка существования экономит постановку в очередь ненужной операции
  if (!this.documents.has(id)) {
    return false;
  }

  return this._enqueue(async () => {
    // Повторная проверка внутри критической секции (на случай, если документ был удален, пока операция ждала)
    if (!this.documents.has(id)) {
      return false; 
    }
    
    // _enqueueDataModification для REMOVE должен вернуть boolean или объект,
    // указывающий на успех. getResult функция формирует итоговый boolean.
    const success = await this._enqueueDataModification(
      { op: 'REMOVE', id },
      'REMOVE',
      (_prev, _next) => true, // Если _enqueueDataModification не упал, считаем успешным
      { idToRemove: id } // extra, если нужен для получения prevDoc в _enqueueDataModification
    );

    if (success) { // Только если операция в _enqueueDataModification была успешной
        this._stats.removes++;
    }
    return success; 
  });
}

/**
 * Удаляет несколько документов, соответствующих предикату.
 * Если при удалении одного из документов возникает ошибка, операция removeMany
 * может продолжить удаление остальных или прерваться, в зависимости от реализации.
 * Текущая реализация продолжает, но логирует ошибки (если бы они были).
 * @param {function} predicate - Синхронная функция-предикат `(doc) => boolean`.
 * @returns {Promise<number>} - Количество успешно удаленных документов.
 * @throws {Error} если `predicate` не является функцией или возникает непредвиденная ошибка.
 */
async function removeMany(predicate) {
    if (typeof predicate !== 'function') {
        throw new Error('removeMany: predicate должен быть функцией.');
    }

    const idsToRemove = [];
    for (const [id, doc] of this.documents.entries()) {
        if (isAlive(doc) && predicate(doc)) { // Проверяем "живые" документы
            idsToRemove.push(id);
        }
    }

    if (idsToRemove.length === 0) {
        return 0;
    }

    let removedCount = 0;
    for (const id of idsToRemove) {
        try {
            const success = await this.remove(id); // `this.remove` определен выше
            if (success) {
                removedCount++;
            }
        } catch (error) {
            // Если this.remove выбрасывает ошибку, нужно решить, как ее обрабатывать:
            // 1. Проигнорировать и продолжить (как сейчас, если remove не выбрасывает ошибку наверх)
            // 2. Собрать ошибки и вернуть их
            // 3. Прервать removeMany и выбросить первую ошибку
            // Для консистентности с updateMany, лучше прерывать и выбрасывать ошибку:
            // logger.error(`[Ops] Error removing document ${id} in removeMany. Aborting. Error: ${error.message}`);
            throw error; // Если хотим прерывать по первой ошибке
        }
    }
    return removedCount;
}


/**
 * Полностью очищает коллекцию (удаляет все документы).
 * @returns {Promise<boolean>} - `true`, если очистка прошла успешно.
 * @throws {Error} если возникает ошибка при очистке.
 */
async function clear() {
  return this._enqueue(async () => {
    // _enqueueDataModification для 'CLEAR' должен обработать очистку документов и индексов.
    // getResult просто подтверждает, что операция была поставлена в очередь и (предположительно) выполнена.
    const success = await this._enqueueDataModification(
      { op: 'CLEAR' },
      'CLEAR',
      () => true 
    );
    
    // Обновление статистики после подтверждения операции
    // applyWalEntryToMemory для 'CLEAR' должен был очистить this.documents.
    // А также this._indexManager.clearAllData().
    if (success) {
        this._stats.clears++;
        this._stats.inserts = 0; 
        this._stats.updates = 0;
        this._stats.removes = 0;
        this._stats.walEntriesSinceCheckpoint = 0; // Также сбрасываем счетчик WAL
    }
    return success;
  });
}

module.exports = {
  insert,
  insertMany,
  // insertManyBatch, // Раскомментировать, если есть отдельная логика
  update,
  updateMany,
  // updateManyBatch, // Раскомментировать, если есть отдельная логика
  remove,
  removeMany,
  clear,
};