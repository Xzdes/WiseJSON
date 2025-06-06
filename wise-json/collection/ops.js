// wise-json/collection/ops.js

/**
 * Реализация основных операций коллекции для WiseJSON.
 * Методы привязываются через .bind(this) к экземпляру Collection.
 */

async function insert(doc) {
    if (!this.isPlainObject(doc)) throw new Error('insert: аргумент должен быть объектом.');
    return this._enqueue(async () => {
        const _id = doc._id || this._idGenerator();
        const now = new Date().toISOString();
        const finalDoc = { ...doc, _id, createdAt: now, updatedAt: now };
        const result = await this._enqueueDataModification(
            { op: 'INSERT', doc: finalDoc },
            'INSERT',
            (_, inserted) => inserted
        );
        this._stats.inserts++;
        return result;
    });
}

async function insertMany(docs) {
    if (!Array.isArray(docs)) throw new Error('insertMany: Argument must be an array');
    const now = new Date().toISOString();
    const prepared = docs.map(doc => ({
        ...doc,
        _id: doc._id || this._idGenerator(),
        createdAt: now,
        updatedAt: now
    }));
    return this._enqueue(async () => {
        await this._enqueueDataModification(
            { op: 'BATCH_INSERT', docs: prepared },
            'BATCH_INSERT',
            (_, inserted) => inserted
        );
        this._stats.inserts += prepared.length;
        return prepared;
    });
}

async function insertManyBatch(docs) {
    return this.insertMany(docs);
}

async function update(id, updates) {
    if (!this.documents.has(id)) throw new Error(`update: документ с id "${id}" не найден.`);
    if (!this.isPlainObject(updates)) throw new Error('update: обновления должны быть объектом.');
    return this._enqueue(async () => {
        const now = new Date().toISOString();
        const result = await this._enqueueDataModification(
            { op: 'UPDATE', id, data: { ...updates, updatedAt: now } },
            'UPDATE',
            (prev, next) => next,
            { id }
        );
        this._stats.updates++;
        return result;
    });
}

async function updateMany(queryFn, updates) {
    if (typeof queryFn !== 'function') throw new Error('updateMany: требуется функция-предикат');
    let count = 0;
    for (const [id, doc] of this.documents.entries()) {
        if (queryFn(doc)) {
            await this.update(id, updates); // Через очередь (всё корректно)
            count++;
        }
    }
    return count;
}

async function updateManyBatch(queryFn, updates) {
    return this.updateMany(queryFn, updates);
}

async function remove(id) {
    if (!this.documents.has(id)) return false;
    return this._enqueue(async () => {
        const result = await this._enqueueDataModification(
            { op: 'REMOVE', id },
            'REMOVE',
            () => true,
            { id }
        );
        this._stats.removes++;
        return result;
    });
}

async function clear() {
    return this._enqueue(async () => {
        const result = await this._enqueueDataModification(
            { op: 'CLEAR' },
            'CLEAR',
            () => true
        );
        this.documents.clear();
        this._indexManager.clearAllData();
        this._stats.clears++;
        return result;
    });
}

module.exports = {
    insert,
    insertMany,
    insertManyBatch,
    update,
    updateMany,
    updateManyBatch,
    remove,
    clear,
};
