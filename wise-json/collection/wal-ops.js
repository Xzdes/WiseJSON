const fs = require('fs/promises');
const path = require('path');
const { isPlainObject } = require('./utils.js');
const { isAlive } = require('./ttl.js');

/**
 * Генерирует строку для WAL (одна операция).
 */
function walEntryToString(entry) {
    return JSON.stringify(entry) + '\n';
}

/**
 * Читает все строки WAL и возвращает массив объектов.
 * @param {string} walFile
 * @returns {Promise<Object[]>}
 */
async function readWalEntries(walFile, sinceTimestamp = null) {
    let raw;
    try {
        raw = await fs.readFile(walFile, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
    const lines = raw.trim().split('\n');
    const result = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            result.push(entry);
        } catch (e) {}
    }
    return result;
}

function createWalOps({ documents, _performCheckpoint, _emitter, _updateIndexesAfterInsert, _updateIndexesAfterRemove, _updateIndexesAfterUpdate, _triggerCheckpointIfRequired, options, walPath }) {

    /**
     * Применяет одну запись WAL к памяти (и к индексам)
     */
    function applyWalEntryToMemory(entry, emit = true) {
        if (entry.op === 'INSERT') {
            const doc = entry.doc;
            if (doc && isAlive(doc)) {
                documents.set(doc._id, doc);
                _updateIndexesAfterInsert && _updateIndexesAfterInsert(doc);
                if (emit) _emitter.emit('insert', doc);
            }
        } else if (entry.op === 'BATCH_INSERT') {
            const docs = Array.isArray(entry.docs) ? entry.docs : [];
            for (const doc of docs) {
                if (doc && isAlive(doc)) {
                    documents.set(doc._id, doc);
                    _updateIndexesAfterInsert && _updateIndexesAfterInsert(doc);
                    if (emit) _emitter.emit('insert', doc);
                }
            }
        } else if (entry.op === 'UPDATE') {
            const id = entry.id;
            const prev = documents.get(id);
            if (prev && isAlive(prev)) {
                const updated = { ...prev, ...entry.data };
                documents.set(id, updated);
                _updateIndexesAfterUpdate && _updateIndexesAfterUpdate(prev, updated);
                if (emit) _emitter.emit('update', updated, prev);
            }
        } else if (entry.op === 'REMOVE') {
            const id = entry.id;
            const prev = documents.get(id);
            if (prev) {
                documents.delete(id);
                _updateIndexesAfterRemove && _updateIndexesAfterRemove(prev);
                if (emit) _emitter.emit('remove', prev);
            }
        } else if (entry.op === 'CLEAR') {
            for (const [id, doc] of documents.entries()) {
                documents.delete(id);
                _updateIndexesAfterRemove && _updateIndexesAfterRemove(doc);
            }
            if (emit) _emitter.emit('clear');
        }
    }

    /**
     * Основная функция для записи операции в WAL, выполнения её в памяти, чекпоинта и т.д.
     * opType: INSERT, BATCH_INSERT, UPDATE, REMOVE, CLEAR
     */
    async function enqueueDataModification(entry, opType, getResult, extra = {}) {
        // Гарантируем, что папка для WAL существует!
        await fs.mkdir(path.dirname(walPath), { recursive: true });

        // Записываем в WAL
        await fs.appendFile(walPath, walEntryToString(entry), 'utf8');

        // Применяем к памяти и индексам
        applyWalEntryToMemory(entry, true);
        if (typeof _triggerCheckpointIfRequired === 'function') {
            _triggerCheckpointIfRequired(entry);
        }

        // Результат для пользователя (по callback, чтобы можно было что угодно вернуть)
        let prev = null, next = null;
        if (opType === 'INSERT') {
            next = entry.doc;
        } else if (opType === 'BATCH_INSERT') {
            next = entry.docs;
        } else if (opType === 'UPDATE') {
            prev = documents.get(entry.id);
            next = { ...prev, ...entry.data };
        } else if (opType === 'REMOVE') {
            prev = documents.get(entry.id);
        }
        return getResult ? getResult(prev, next) : undefined;
    }

    return {
        applyWalEntryToMemory,
        enqueueDataModification
    };
}

module.exports = createWalOps;
