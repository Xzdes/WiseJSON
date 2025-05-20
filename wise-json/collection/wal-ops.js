// collection/wal-ops.js

const { nowIso, deepCloneJson } = require('./utils.js');
const { appendToWal } = require('../wal-manager.js');

/**
 * Создаёт функции для работы с WAL внутри Collection.
 * @param {object} context
 * @param {Map<string, object>} context.documents
 * @param {Function} context._performCheckpoint
 * @param {CollectionEventEmitter} context._emitter
 * @param {Function} context._updateIndexesAfterInsert
 * @param {Function} context._updateIndexesAfterRemove
 * @param {Function} context._updateIndexesAfterUpdate
 * @param {Function} context._triggerCheckpointIfRequired
 * @param {object} context.options
 * @param {string} context.walPath
 * @returns {object}
 */
function createWalOps(context) {
    const {
        documents,
        _performCheckpoint,
        _emitter,
        _updateIndexesAfterInsert,
        _updateIndexesAfterRemove,
        _updateIndexesAfterUpdate,
        _triggerCheckpointIfRequired,
        options,
        walPath,
    } = context;

    /**
     * Применяет одну запись WAL к памяти.
     * @param {object} entry
     * @param {boolean} isLive
     * @returns {object|null}
     */
    function applyWalEntryToMemory(entry, isLive = true) {
        if (!entry || typeof entry.op !== 'string') return null;

        const ts = entry.ts || (isLive ? nowIso() : null);
        let result = null;

        switch (entry.op) {
            case 'INSERT':
                if (entry.doc && typeof entry.doc._id === 'string') {
                    const doc = { ...entry.doc };
                    doc.createdAt = doc.createdAt || ts;
                    doc.updatedAt = doc.updatedAt || ts;
                    documents.set(doc._id, doc);
                    result = doc;
                }
                break;

            case 'UPDATE':
                if (typeof entry.id === 'string' && entry.data && typeof entry.data === 'object') {
                    const existing = documents.get(entry.id);
                    if (existing) {
                        const updated = { ...existing, ...entry.data, updatedAt: entry.data.updatedAt || ts };
                        documents.set(entry.id, updated);
                        result = updated;
                    }
                }
                break;

            case 'REMOVE':
                if (typeof entry.id === 'string') {
                    result = documents.get(entry.id) || null;
                    if (result) documents.delete(entry.id);
                }
                break;

            case 'CLEAR':
                documents.clear();
                break;

            default:
                console.warn(`[Collection] Неизвестная операция в WAL: '${entry.op}'`);
        }

        return result;
    }

    /**
     * Выполняет WAL-запись + применение к памяти + событие.
     * @param {object} walEntry
     * @param {string} opType
     * @param {Function} getResultFn
     * @param {object} [eventInfo]
     * @returns {Promise<any>}
     */
    async function enqueueDataModification(walEntry, opType, getResultFn, eventInfo = {}) {
        const ts = nowIso();
        const finalEntry = { ...walEntry, ts };

        const preImage = (eventInfo.id && documents.has(eventInfo.id))
            ? deepCloneJson(documents.get(eventInfo.id))
            : null;

        await appendToWal(walPath, finalEntry, options.walForceSync);
        const inMem = applyWalEntryToMemory(finalEntry, true);
        const result = getResultFn(preImage, inMem);

        try {
            if (opType === 'INSERT') _updateIndexesAfterInsert(inMem);
            if (opType === 'UPDATE') _updateIndexesAfterUpdate(preImage, inMem);
            if (opType === 'REMOVE') _updateIndexesAfterRemove(preImage);
            if (opType === 'CLEAR') {
                // Очистить все индексы — делается в вызывающем коде
            }
        } catch (indexErr) {
            console.error(`[Collection] Ошибка обновления индексов после ${opType}: ${indexErr.message}`);
        }

        if (_emitter) {
            try {
                const eventName = `after${opType.charAt(0).toUpperCase() + opType.slice(1).toLowerCase()}`;
                if (opType === 'INSERT') _emitter.emit(eventName, result);
                if (opType === 'UPDATE') _emitter.emit(eventName, result, preImage);
                if (opType === 'REMOVE') _emitter.emit(eventName, eventInfo.id, preImage);
                if (opType === 'CLEAR') _emitter.emit(eventName);
            } catch (e) {
                console.error(`[Collection] Ошибка в событии '${opType}': ${e.message}`);
            }
        }

        _triggerCheckpointIfRequired(opType);
        return result;
    }

    return {
        applyWalEntryToMemory,
        enqueueDataModification,
    };
}

module.exports = createWalOps;
