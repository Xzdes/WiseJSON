// wise-json/collection/ops.js

const { isAlive } = require('./ttl.js'); 
const logger = require('../logger'); // Убедитесь, что logger импортирован

async function insert(doc) {
  if (!this.isPlainObject(doc)) {
    throw new Error('insert: аргумент должен быть объектом.');
  }
  return this._enqueue(async () => {
    const _id = doc._id || this._idGenerator(); 
    const now = new Date().toISOString();
    const finalDoc = {
      ...doc,
      _id,
      createdAt: doc.createdAt || now,
      updatedAt: now,
    };
    const result = await this._enqueueDataModification(
      { op: 'INSERT', doc: finalDoc },
      'INSERT',
      (_prev, insertedDoc) => insertedDoc
    );
    this._stats.inserts++; 
    return result;
  });
}

async function insertMany(docs) {
    if (!Array.isArray(docs)) {
        throw new Error('insertMany: аргумент должен быть массивом.');
    }
    if (docs.length === 0) {
        return [];
    }

    // Максимальное количество документов в одной WAL-записи BATCH_INSERT.
    // Можно сделать настраиваемым через this.options, если необходимо.
    const MAX_DOCS_PER_BATCH_WAL_ENTRY = this.options?.maxDocsPerBatchWalEntry || 1000; 
    // Если в this.options нет maxDocsPerBatchWalEntry, используем 1000 по умолчанию.

    // Вся операция insertMany (включая все чанки) должна быть атомарной
    // с точки зрения блокировки коллекции, поэтому оборачиваем все в один _enqueue.
    return this._enqueue(async () => {
        await this._acquireLock(); // Захватываем блокировку в начале
        const allInsertedDocs = [];
        let totalProcessed = 0;

        try {
            for (let i = 0; i < docs.length; i += MAX_DOCS_PER_BATCH_WAL_ENTRY) {
                const chunk = docs.slice(i, i + MAX_DOCS_PER_BATCH_WAL_ENTRY);
                // logger.debug(`[Ops] insertMany: обрабатываем чанк ${i / MAX_DOCS_PER_BATCH_WAL_ENTRY + 1} из ${Math.ceil(docs.length / MAX_DOCS_PER_BATCH_WAL_ENTRY)}, размер: ${chunk.length}`);
                
                const now = new Date().toISOString();
                const preparedChunk = chunk.map(doc => ({
                    ...doc,
                    _id: doc._id || this._idGenerator(),
                    createdAt: doc.createdAt || now, // Используем один 'now' для всего чанка
                    updatedAt: now,
                }));

                // Каждая порция (chunk) записывается как отдельная BATCH_INSERT операция в WAL
                // _enqueueDataModification выполняет запись в WAL и применение в памяти.
                // Важно: _enqueueDataModification сам по себе не должен вызывать _acquireLock/_releaseLock,
                // так как мы уже под общей блокировкой.
                const insertedChunk = await this._enqueueDataModification( // Предполагается, что этот метод не вызывает _acquireLock
                    { op: 'BATCH_INSERT', docs: preparedChunk },
                    'BATCH_INSERT',
                    (_prev, inserted) => inserted
                );
                
                if (Array.isArray(insertedChunk)) { // Убедимся, что результат - массив
                    allInsertedDocs.push(...insertedChunk);
                    this._stats.inserts += insertedChunk.length;
                    totalProcessed += insertedChunk.length;
                } else {
                    // Это не должно произойти, если _enqueueDataModification для BATCH_INSERT возвращает массив
                    logger.warn(`[Ops] insertMany: _enqueueDataModification для чанка не вернул массив. Чанк пропущен или обработан некорректно.`);
                }
            }
            // logger.debug(`[Ops] insertMany: успешно обработано ${totalProcessed} документов из ${docs.length}.`);
            return allInsertedDocs;
        } catch (error) {
            // Если произошла ошибка при обработке любого из чанков (например, нарушение уникальности
            // которое было проверено внутри _enqueueDataModification, или ошибка записи WAL для чанка),
            // то вся операция insertMany откатывается (т.к. мы под одним _enqueue).
            // В текущей реализации _enqueueDataModification сам бросит ошибку, и она будет поймана
            // обработчиком ошибок в _processQueue, который вызовет task.reject(err).
            // Поэтому здесь мы просто пробрасываем ошибку дальше.
            logger.error(`[Ops] insertMany: ошибка во время обработки чанков: ${error.message}. Обработано до ошибки: ${totalProcessed} документов.`);
            throw error;
        } finally {
            await this._releaseLockIfHeld(); // Освобождаем блокировку в конце
        }
    });
}


async function update(id, updates) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('update: id должен быть непустой строкой.');
  }
  if (!this.isPlainObject(updates)) {
    throw new Error('update: обновления должны быть объектом.');
  }
  
  return this._enqueue(async () => {
    if (!this.documents.has(id)) {
      return null; 
    }
    const now = new Date().toISOString();
    const result = await this._enqueueDataModification(
      { op: 'UPDATE', id, data: { ...updates, updatedAt: now } },
      'UPDATE',
      (_prev, updatedDoc) => updatedDoc,
      { idToUpdate: id } 
    );
    if (result) { 
        this._stats.updates++;
    }
    return result;
  });
}

async function updateMany(queryFn, updates) {
  if (typeof queryFn !== 'function') {
    throw new Error('updateMany: queryFn должен быть функцией.');
  }
  if (!this.isPlainObject(updates)) { 
    throw new Error('updateMany: обновления должны быть объектом.');
  }

  // Собираем ID ДО постановки в очередь, чтобы не итерировать по изменяемой коллекции.
  const idsToUpdate = [];
  // Эта часть выполняется вне _enqueue, читая текущее состояние this.documents.
  // Это нормально, так как фактические изменения будут в _enqueue.
  for (const [id, doc] of this.documents.entries()) {
      if (isAlive(doc) && queryFn(doc)) { 
          idsToUpdate.push(id);
      }
  }

  if (idsToUpdate.length === 0) {
    return 0; 
  }

  // Все обновления для updateMany выполняются в рамках одного _enqueue вызова
  // для обеспечения атомарности на уровне всей операции updateMany, если это возможно.
  // Однако, this.update внутри цикла сам вызывает _enqueue.
  // Чтобы сделать updateMany по-настоящему атомарным (все или ничего для всех найденных документов),
  // потребовалась бы другая архитектура для _enqueueDataModification, принимающая массив обновлений.
  // Текущая реализация делает каждую отдельную операцию update атомарной, но не весь updateMany.

  // Оставляем текущую реализацию, где каждое обновление - отдельная операция в очереди.
  // Это проще, но менее атомарно для всего набора.
  let successfullyUpdatedCount = 0;
  for (const id of idsToUpdate) { // Этот цикл выполнится вне _enqueue
    try {
      // Каждый this.update будет поставлен в очередь и выполнен последовательно.
      const updatedDoc = await this.update(id, updates); 
      if (updatedDoc) { 
            successfullyUpdatedCount++;
      }
    } catch (error) {
      // Если один из update падает (например, нарушение уникальности),
      // то updateMany прерывается здесь, и предыдущие успешные обновления остаются.
      logger.error(`[Ops] Ошибка при обновлении документа ID '${id}' в updateMany. Прерывание. Ошибка: ${error.message}`);
      throw error; 
    }
  }
  return successfullyUpdatedCount;
}

async function remove(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('remove: id должен быть непустой строкой.');
  }
  
  if (!this.documents.has(id)) {
    return false;
  }

  return this._enqueue(async () => {
    if (!this.documents.has(id)) { 
      return false; 
    }
    
    const success = await this._enqueueDataModification(
      { op: 'REMOVE', id },
      'REMOVE',
      (_prev, _next) => true, 
      { idToRemove: id } 
    );

    if (success) { 
        this._stats.removes++;
    }
    return success; 
  });
}

async function removeMany(predicate) {
    if (typeof predicate !== 'function') {
        throw new Error('removeMany: predicate должен быть функцией.');
    }

    const idsToRemove = [];
    for (const [id, doc] of this.documents.entries()) {
        if (isAlive(doc) && predicate(doc)) { 
            idsToRemove.push(id);
        }
    }

    if (idsToRemove.length === 0) {
        return 0;
    }

    let removedCount = 0;
    for (const id of idsToRemove) { // Аналогично updateMany, цикл вне _enqueue
        try {
            const success = await this.remove(id); // Каждый remove ставится в очередь
            if (success) {
                removedCount++;
            }
        } catch (error) {
            logger.error(`[Ops] Ошибка при удалении документа ID '${id}' в removeMany. Прерывание. Ошибка: ${error.message}`);
            throw error; 
        }
    }
    return removedCount;
}


async function clear() {
  return this._enqueue(async () => {
    const success = await this._enqueueDataModification(
      { op: 'CLEAR' },
      'CLEAR',
      () => true 
    );
    
    if (success) {
        this._stats.clears++;
        this._stats.inserts = 0; 
        this._stats.updates = 0;
        this._stats.removes = 0;
        this._stats.walEntriesSinceCheckpoint = 0; 
    }
    return success;
  });
}

module.exports = {
  insert,
  insertMany,
  update,
  updateMany,
  remove,
  removeMany,
  clear,
};