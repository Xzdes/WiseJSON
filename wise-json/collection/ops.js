// wise-json/collection/ops.js

const { isAlive } = require('./ttl.js'); 
const logger = require('../logger');

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
    // Это значение можно сделать настраиваемым через опции коллекции, если потребуется.
    const MAX_DOCS_PER_BATCH_WAL_ENTRY = this.options?.maxDocsPerBatchWalEntry || 1000;

    if (docs.length <= MAX_DOCS_PER_BATCH_WAL_ENTRY) {
        // Если документов немного, обрабатываем как один батч
        return this._enqueue(async () => {
            await this._acquireLock(); // Блокировка на всю операцию
            try {
                const now = new Date().toISOString();
                const preparedDocs = docs.map(doc => ({
                    ...doc,
                    _id: doc._id || this._idGenerator(),
                    createdAt: doc.createdAt || now,
                    updatedAt: now,
                }));

                const result = await this._enqueueDataModification(
                    { op: 'BATCH_INSERT', docs: preparedDocs },
                    'BATCH_INSERT',
                    (_prev, insertedDocs) => insertedDocs
                );
                this._stats.inserts += result.length;
                return result;
            } finally {
                await this._releaseLockIfHeld();
            }
        });
    } else {
        // Если документов много, разбиваем на чанки
        // logger.debug(`[Ops] insertMany: разбиваем ${docs.length} документов на чанки по ${MAX_DOCS_PER_BATCH_WAL_ENTRY}`);
        const allInsertedDocs = [];
        // Одна общая блокировка на весь процесс чанкинга
        return this._enqueue(async () => {
            await this._acquireLock();
            try {
                for (let i = 0; i < docs.length; i += MAX_DOCS_PER_BATCH_WAL_ENTRY) {
                    const chunk = docs.slice(i, i + MAX_DOCS_PER_BATCH_WAL_ENTRY);
                    const now = new Date().toISOString();
                    
                    const preparedChunk = chunk.map(doc => ({
                        ...doc,
                        _id: doc._id || this._idGenerator(),
                        createdAt: doc.createdAt || now,
                        updatedAt: now,
                    }));

                    // Каждая порция (chunk) записывается как отдельная BATCH_INSERT операция в WAL
                    // _enqueueDataModification выполняет запись в WAL и применение в памяти
                    const insertedChunk = await this._enqueueDataModification(
                        { op: 'BATCH_INSERT', docs: preparedChunk },
                        'BATCH_INSERT',
                        (_prev, inserted) => inserted
                    );
                    
                    allInsertedDocs.push(...insertedChunk);
                    this._stats.inserts += insertedChunk.length; 
                    // Нет необходимости в this.insertMany(chunk) рекурсии, т.к. мы уже внутри _enqueue
                    // и напрямую вызываем _enqueueDataModification для каждого чанка.
                }
                return allInsertedDocs;
            } finally {
                await this._releaseLockIfHeld();
            }
        });
    }
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

  const idsToUpdate = [];
  for (const [id, doc] of this.documents.entries()) {
      if (isAlive(doc) && queryFn(doc)) { 
          idsToUpdate.push(id);
      }
  }

  if (idsToUpdate.length === 0) {
    return 0; 
  }

  // Для updateMany лучше выполнять все обновления в одной "транзакции" _enqueue,
  // чтобы избежать многократных захватов/освобождений блокировки.
  // Но this.update уже использует _enqueue.
  // Если мы хотим атомарности для всего updateMany (все или ничего),
  // то нужна поддержка транзакций на уровне _enqueueDataModification
  // или явное использование db.beginTransaction().
  // Текущая реализация (цикл с await this.update()) корректна, но каждая
  // операция update будет отдельной записью в WAL и отдельной блокировкой.

  // Для улучшения (но это более крупное изменение, выходящее за рамки "одного файла"):
  // Можно было бы собрать все ID и обновления, и передать в специальный
  // _enqueueDataModification({ op: 'BATCH_UPDATE', updates: [{id, data}, ...] }),
  // который бы применил их атомарно.

  // Оставляем текущую реализацию, так как она работает и соответствует
  // принципу "одно изменение за раз" для этой итерации правок.
  let successfullyUpdatedCount = 0;
  for (const id of idsToUpdate) {
    try {
      const updatedDoc = await this.update(id, updates); 
      if (updatedDoc) { 
            successfullyUpdatedCount++;
      }
    } catch (error) {
      throw error; 
    }
  }
  return successfullyUpdatedCount;
}

async function remove(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('remove: id должен быть непустой строкой.');
  }
  
  if (!this.documents.has(id)) { // Оптимизация: быстрая проверка до постановки в очередь
    return false;
  }

  return this._enqueue(async () => {
    if (!this.documents.has(id)) { // Повторная проверка внутри критической секции
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

    // Аналогично updateMany, для полной атомарности всего removeMany
    // потребовались бы более глубокие изменения.
    // Текущая реализация удаляет документы по одному.
    let removedCount = 0;
    for (const id of idsToRemove) {
        try {
            const success = await this.remove(id); 
            if (success) {
                removedCount++;
            }
        } catch (error) {
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