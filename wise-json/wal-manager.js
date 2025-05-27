const fs = require('fs/promises');
const path = require('path');

/**
 * Возвращает путь к WAL-файлу для коллекции.
 * @param {string} collectionDirPath
 * @param {string} collectionName
 * @returns {string}
 */
function getWalPath(collectionDirPath, collectionName) {
    return path.join(collectionDirPath, `wal_${collectionName}.log`);
}

/**
 * Инициализация WAL-файла (создаёт файл, если не существует).
 * @param {string} walPath
 * @param {string} collectionDirPath
 * @returns {Promise<void>}
 */
async function initializeWal(walPath, collectionDirPath) {
    await fs.mkdir(collectionDirPath, { recursive: true });
    try {
        await fs.access(walPath);
    } catch (e) {
        if (e.code === 'ENOENT') {
            await fs.writeFile(walPath, '', 'utf8');
        } else {
            throw e;
        }
    }
}

/**
 * Записать новую запись (обычную или транзакционную) в WAL.
 * @param {string} walPath
 * @param {object} entry
 * @returns {Promise<void>}
 */
async function appendWalEntry(walPath, entry) {
    await fs.appendFile(walPath, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Чтение WAL-файла.
 * sinceTimestamp (опционально) — только записи, созданные ПОСЛЕ указанного ISO timestamp.
 * Для транзакций: если блок не завершён (нет TXN_COMMIT), его операции не применять.
 * @param {string} walPath
 * @param {string|null} sinceTimestamp
 * @param {object} [options] - { strict: boolean, onError: function }
 * @returns {Promise<Array<Object>>}
 */
async function readWal(walPath, sinceTimestamp = null, options = {}) {
    let raw;
    try {
        raw = await fs.readFile(walPath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
    const lines = raw.trim().split('\n');
    const result = [];

    // Для обработки транзакций
    const txnStates = {}; // { txid: { ops: [], committed: false } }

    let cutoffTime = null;
    if (sinceTimestamp) {
        try {
            cutoffTime = Date.parse(sinceTimestamp);
            if (isNaN(cutoffTime)) cutoffTime = null;
        } catch {
            cutoffTime = null;
        }
    }

    for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch (e) {
            if (typeof options.onError === 'function') {
                options.onError(e, line);
            } else if (options.strict) {
                throw new Error(`[WAL] Не удалось распарсить запись WAL: ${e.stack || e.message}`);
            } else {
                console.warn(`[WAL] ⚠ Не удалось распарсить запись WAL: ${e.stack || e.message}`);
            }
            continue;
        }

        // Если это транзакционный блок
        if (entry.txn) {
            if (entry.txn === 'start') {
                txnStates[entry.id] = { ops: [], committed: false };
            } else if (entry.txn === 'op') {
                if (txnStates[entry.txid]) txnStates[entry.txid].ops.push(entry);
            } else if (entry.txn === 'commit') {
                if (txnStates[entry.id]) txnStates[entry.id].committed = true;
            }
            continue;
        }

        // Обычные операции (не в транзакции)
        if (cutoffTime && entry && entry.doc && entry.doc.updatedAt) {
            const entryTime = Date.parse(entry.doc.updatedAt);
            if (isNaN(entryTime) || entryTime <= cutoffTime) continue;
        } else if (cutoffTime && entry && entry.docs && Array.isArray(entry.docs)) {
            if (entry.docs.length > 0 && entry.docs[0].updatedAt) {
                const entryTime = Date.parse(entry.docs[0].updatedAt);
                if (isNaN(entryTime) || entryTime <= cutoffTime) continue;
            }
        }
        result.push(entry);
    }

    // После чтения — добавить только завершённые транзакции
    for (const [txid, state] of Object.entries(txnStates)) {
        if (state.committed) {
            for (const op of state.ops) {
                result.push({ ...op, _txn_applied: true });
            }
        }
    }

    if (sinceTimestamp) {
        console.log(`[WAL] Прочитано ${result.length} записей WAL, созданных после checkpoint (${sinceTimestamp})`);
    } else {
        console.log(`[WAL] Прочитано ${result.length} записей WAL (без фильтрации по времени)`);
    }
    return result;
}

/**
 * Компакция WAL: после успешного checkpoint удаляет старые операции из WAL (до чекпоинта).
 * @param {string} walPath
 * @param {string|null} sinceTimestamp
 * @returns {Promise<void>}
 */
async function compactWal(walPath, sinceTimestamp = null) {
    if (!sinceTimestamp) return;
    const allEntries = await readWal(walPath);
    let cutoffTime = Date.parse(sinceTimestamp);
    if (isNaN(cutoffTime)) cutoffTime = null;

    const filtered = allEntries.filter(entry => {
        if (entry && entry.doc && entry.doc.updatedAt) {
            const entryTime = Date.parse(entry.doc.updatedAt);
            return cutoffTime && !isNaN(entryTime) && entryTime > cutoffTime;
        }
        if (entry && entry.docs && Array.isArray(entry.docs) && entry.docs.length > 0) {
            const entryTime = Date.parse(entry.docs[0].updatedAt);
            return cutoffTime && !isNaN(entryTime) && entryTime > cutoffTime;
        }
        // Пропускаем транзакционные операции (они уже внутри опов)
        if (entry.txn) return false;
        return false;
    });

    // Перезаписываем WAL только с новыми (после чекпоинта) операциями
    const lines = filtered.map(e => JSON.stringify(e)).join('\n');
    await fs.writeFile(walPath, lines.length ? lines + '\n' : '', 'utf8');
    console.log(`[WAL] Компакция WAL завершена. Осталось ${filtered.length} записей.`);
}

/**
 * Записать атомарный блок транзакции в WAL.
 * TXN_START, TXN_OP..., TXN_COMMIT
 * @param {string} walPath
 * @param {string} txid
 * @param {Array<{colName,type,args}>} ops
 * @returns {Promise<void>}
 */
async function writeTransactionBlock(walPath, txid, ops) {
    let block = [];
    block.push({ txn: 'start', id: txid, ts: new Date().toISOString() });
    for (const op of ops) {
        block.push({
            txn: 'op',
            txid,
            col: op.colName,
            type: op.type,
            args: op.args,
            ts: new Date().toISOString()
        });
    }
    block.push({ txn: 'commit', id: txid, ts: new Date().toISOString() });
    const text = block.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(walPath, text, 'utf8');
}

module.exports = {
    getWalPath,
    initializeWal,
    readWal,
    compactWal,
    appendWalEntry,
    writeTransactionBlock
};
