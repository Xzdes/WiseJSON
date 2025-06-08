// wise-json/wal-manager.js

const fs = require('fs/promises');
const path = require('path');
const logger = require('./logger');

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
 * Асинхронная задержка
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Надежно добавляет строку в WAL с retry-логикой.
 * @param {string} walPath
 * @param {string} text
 * @param {number} retries
 */
async function appendFileWithRetry(walPath, text, retries = 5) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
        try {
            await fs.appendFile(walPath, text, 'utf8');
            return;
        } catch (err) {
            lastErr = err;
            // ASSUMPTION: Ретрай только на ENOSPC, EBUSY, EIO, временные сбои
            if (i < retries && ['ENOSPC', 'EBUSY', 'EIO', 'EMFILE', 'EAGAIN'].includes(err.code)) {
                const wait = 100 * (i + 1);
                logger.warn(`[WAL] appendFile retry #${i + 1} for ${walPath}, reason: ${err.code} (${wait}ms)`);
                await delay(wait);
                continue;
            } else {
                break;
            }
        }
    }
    // Последняя ошибка
    logger.error(`[WAL] Ошибка appendFile для WAL (после ретраев): ${lastErr && lastErr.message}`);
    throw lastErr;
}

/**
 * Записать новую запись (обычную или транзакционную) в WAL с retry.
 * @param {string} walPath
 * @param {object} entry
 * @param {number} [retries]
 * @returns {Promise<void>}
 */
async function appendWalEntry(walPath, entry, retries = 5) {
    try {
        await appendFileWithRetry(walPath, JSON.stringify(entry) + '\n', retries);
    } catch (err) {
        // ASSUMPTION: Ошибка записи в WAL считается критической для crash-safe механики.
        logger.error(`[WAL] Ошибка appendFile для WAL: ${err.message}`);
        throw err;
    }
}

/**
 * Чтение WAL-файла.
 * sinceTimestamp (опционально) — только записи, созданные ПОСЛЕ указанного ISO timestamp.
 * Для транзакций: если блок не завершён (нет TXN_COMMIT), его операции не применять.
 * @param {string} walPath
 * @param {string|null} sinceTimestamp
 * @param {object} [options] - { strict: boolean, onError: function, recover: boolean }
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

    for (const [lineNum, line] of lines.entries()) {
        if (!line.trim()) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch (e) {
            // strict — бросаем ошибку, recover — пытаемся пропустить одну битую строку, иначе просто warn+skip
            if (typeof options.onError === 'function') {
                options.onError(e, line, lineNum);
            }
            if (options.strict) {
                throw new Error(`[WAL] Не удалось распарсить запись WAL: ${e.stack || e.message}\nLine: ${lineNum}`);
            } else if (options.recover) {
                // recover: просто скипаем и идем дальше (возможно добавить recover-контроль)
                logger.warn(`[WAL] recover: повреждена строка WAL, пропускаю line ${lineNum}`);
                continue;
            } else {
                // default: предупреждение и пропуск
                logger.warn(`[WAL] ⚠ Не удалось распарсить запись WAL: ${e.stack || e.message}\nLine: ${lineNum}`);
                continue;
            }
        }

        // Если это транзакционный блок
        if (entry.txn) {
            if (entry.txn === 'start') {
                txnStates[entry.id] = { ops: [], committed: false, startLine: lineNum };
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
        // Незавершённые (неcommitted) транзакции игнорируются для crash-safety.
    }

    if (sinceTimestamp) {
        logger.log(`[WAL] Прочитано ${result.length} записей WAL, созданных после checkpoint (${sinceTimestamp})`);
    } else {
        logger.log(`[WAL] Прочитано ${result.length} записей WAL (без фильтрации по времени)`);
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

    const lines = filtered.map(e => JSON.stringify(e)).join('\n');
    let attempt = 0;
    const maxAttempts = 3;
    while (true) {
        try {
            await fs.writeFile(walPath, lines.length ? lines + '\n' : '', 'utf8');
            logger.log(`[WAL] Компакция WAL завершена. Осталось ${filtered.length} записей.`);
            break;
        } catch (err) {
            attempt++;
            if (attempt < maxAttempts) {
                logger.warn(`[WAL] Ошибка при компакции WAL (попытка ${attempt}), повторяю: ${err.message}`);
                await delay(100 * attempt);
            } else {
                logger.error(`[WAL] Ошибка при компакции WAL (после ${maxAttempts} попыток): ${err.message}`);
                break;
            }
        }
    }
}

/**
 * Записать атомарный блок транзакции в WAL с retry.
 * TXN_START, TXN_OP..., TXN_COMMIT
 * @param {string} walPath
 * @param {string} txid
 * @param {Array<{colName,type,args}>} ops
 * @param {number} [retries]
 * @returns {Promise<void>}
 */
async function writeTransactionBlock(walPath, txid, ops, retries = 5) {
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
    let attempt = 0;
    let lastErr = null;
    while (attempt <= retries) {
        try {
            await fs.appendFile(walPath, text, 'utf8');
            return;
        } catch (err) {
            lastErr = err;
            attempt++;
            if (attempt <= retries && ['ENOSPC', 'EBUSY', 'EIO', 'EMFILE', 'EAGAIN'].includes(err.code)) {
                const wait = 100 * attempt;
                logger.warn(`[WAL] writeTransactionBlock retry #${attempt} for ${walPath}, reason: ${err.code} (${wait}ms)`);
                await delay(wait);
                continue;
            } else {
                break;
            }
        }
    }
    // ASSUMPTION: Ошибка при записи блока транзакции делает транзакцию несостоятельной — вызываем ошибку.
    logger.error(`[WAL] Ошибка записи транзакционного блока (после ретраев): ${lastErr && lastErr.message}`);
    throw lastErr;
}

module.exports = {
    getWalPath,
    initializeWal,
    readWal,
    compactWal,
    appendWalEntry,
    writeTransactionBlock
};
