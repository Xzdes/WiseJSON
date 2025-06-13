// wise-json/wal-manager.js

const fs = require('fs/promises'); // Используем промисы
const path = require('path');
const logger = require('./logger');

// getWalPath, initializeWal, delay - без изменений

function getWalPath(collectionDirPath, collectionName) {
    return path.join(collectionDirPath, `wal_${collectionName}.log`);
}

async function initializeWal(walPath, collectionDirPath) {
    if (typeof walPath !== 'string') { 
        logger.error(`[WAL Critical] initializeWal: walPath не является строкой! Тип: ${typeof walPath}, Значение: ${walPath}`);
        throw new TypeError('walPath должен быть строкой в initializeWal');
    }
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

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function appendAndSyncWalRecord(walPath, text, appendRetries = 5, fsyncRetries = 3, fsyncInitialDelayMs = 100) {
    const lineToWrite = text + '\n'; 
    let lastAppendError = null;

    for (let i = 0; i <= appendRetries; i++) {
        try {
            await fs.appendFile(walPath, lineToWrite, 'utf8');
            lastAppendError = null; 
            break; 
        } catch (err) {
            lastAppendError = err;
            if (i < appendRetries && ['ENOSPC', 'EBUSY', 'EIO', 'EMFILE', 'EAGAIN'].includes(err.code)) {
                const wait = 100 * (i + 1);
                await delay(wait);
                continue;
            } else {
                logger.error(`[WAL] Ошибка appendFile для WAL '${walPath}' (после ${i + 1} попыток): ${lastAppendError?.message}`);
                throw lastAppendError; 
            }
        }
    }

    if (lastAppendError) {
        throw lastAppendError;
    }

    let fileHandle; 
    let lastSyncError = null;
    let currentFsyncDelay = fsyncInitialDelayMs;

    for (let j = 0; j < fsyncRetries; j++) {
        fileHandle = undefined; // Сбрасываем перед каждой попыткой open
        try {
            fileHandle = await fs.open(walPath, 'r+'); 
            await fileHandle.sync(); // ИЗМЕНЕНИЕ: fsync -> sync
            lastSyncError = null; 
            break; 
        } catch (syncErr) {
            lastSyncError = syncErr;
            logger.warn(`[WAL] Ошибка sync для файла ${walPath} (попытка ${j + 1}/${fsyncRetries}): ${syncErr.message}`);
            if (j < fsyncRetries - 1) {
                await delay(currentFsyncDelay);
                currentFsyncDelay = Math.min(currentFsyncDelay * 2, 2000); 
            }
        } finally {
            if (fileHandle) { 
                try {
                    await fileHandle.close(); // ИЗМЕНЕНИЕ: close остается close
                } catch (closeErr) {
                    logger.warn(`[WAL] Ошибка закрытия fileHandle после попытки sync для ${walPath}: ${closeErr.message}`);
                }
            }
        }
    }

    if (lastSyncError) {
        logger.error(`[WAL] КРИТИЧЕСКАЯ ОШИБКА: не удалось выполнить sync для ${walPath} после ${fsyncRetries} попыток. Ошибка: ${lastSyncError?.message}.`);
        throw lastSyncError;
    }
}

async function appendWalEntry(walPath, entry) {
    try {
        await appendAndSyncWalRecord(walPath, JSON.stringify(entry));
    } catch (err) {
        throw err; 
    }
}

async function writeTransactionBlock(walPath, txid, ops) {
    const nowISO = new Date().toISOString();
    const block = [];
    block.push({ txn: 'start', id: txid, ts: nowISO });
    for (const op of ops) {
        block.push({
            txn: 'op',
            txid,
            col: op.colName,
            type: op.type,
            args: op.args,
            ts: op.ts || nowISO 
        });
    }
    block.push({ txn: 'commit', id: txid, ts: new Date().toISOString() });
    
    const fullTextBlock = block.map(e => JSON.stringify(e)).join('\n');

    try {
        await appendAndSyncWalRecord(walPath, fullTextBlock);
    } catch (err) {
        throw err;
    }
}

async function readWal(walPath, sinceTimestamp = null, options = {}) {
    const effectiveOptions = { strict: false, recover: false, isInitialLoad: false, ...options };
    let rawContent;
    try {
        rawContent = await fs.readFile(walPath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }

    const lines = rawContent.trim().split('\n');
    const recoveredEntries = [];
    const transactionStates = {}; 
    
    let cutoffDateTime = null;
    if (sinceTimestamp) {
        try {
            cutoffDateTime = Date.parse(sinceTimestamp);
            if (isNaN(cutoffDateTime)) {
                logger.warn(`[WAL] Невалидный sinceTimestamp '${sinceTimestamp}' при чтении ${walPath}. Фильтрация по времени отключена.`);
                cutoffDateTime = null;
            }
        } catch (e) {
            logger.warn(`[WAL] Ошибка парсинга sinceTimestamp '${sinceTimestamp}' (${e.message}) при чтении ${walPath}. Фильтрация по времени отключена.`);
            cutoffDateTime = null;
        }
    }

    for (const [idx, line] of lines.entries()) {
        const currentLineNumber = idx + 1;
        if (!line.trim()) continue;

        const MAX_LINE_LEN = 20 * 1024 * 1024; 
        if (line.length > MAX_LINE_LEN) {
            const msg = `[WAL] Строка ${currentLineNumber} в ${walPath} превышает лимит длины (${line.length} > ${MAX_LINE_LEN}), пропускается.`;
            if (effectiveOptions.strict) {
                logger.error(msg + " (strict mode)");
                throw new Error(msg);
            }
            logger.warn(msg);
            continue;
        }
        
        let entry;
        try {
            entry = JSON.parse(line);
        } catch (e) {
            const errorContext = `Ошибка парсинга JSON на строке ${currentLineNumber} в ${walPath}: ${e.message}.`;
            const linePreview = line.substring(0, 150) + (line.length > 150 ? '...' : '');
            
            if (typeof effectiveOptions.onError === 'function') {
                try { effectiveOptions.onError(e, line, currentLineNumber); } 
                catch (userCallbackError) { logger.error(`[WAL] Ошибка в пользовательском onError callback: ${userCallbackError.message}`); }
            }

            if (effectiveOptions.strict) {
                logger.error(errorContext + ` Содержимое (начало): "${linePreview}" (strict mode).`);
                throw new Error(errorContext + ` (strict mode).`);
            } 
            logger.warn(errorContext + ` Содержимое (начало): "${linePreview}" (строка пропущена).`);
            continue;
        }

        if (typeof entry !== 'object' || entry === null) {
            logger.warn(`[WAL] Запись на строке ${currentLineNumber} в ${walPath} не является объектом. Пропущена.`);
            continue;
        }
        
        if (entry.txn) {
            const txTimestamp = entry.ts ? Date.parse(entry.ts) : null;
            const txId = entry.id || entry.txid; 

            if (!txId) {
                logger.warn(`[WAL] Транз. запись '${entry.txn}' без ID на строке ${currentLineNumber}. Игнор.`);
                continue;
            }

            if (entry.txn === 'start') {
                if (transactionStates[txId]) {
                     logger.warn(`[WAL] Повтор TXN_START '${txId}' на стр ${currentLineNumber}. Старая отменена.`);
                }
                transactionStates[txId] = { ops: [], committed: false, startLine: currentLineNumber, timestamp: txTimestamp };
            } else if (entry.txn === 'op') {
                if (!transactionStates[txId] || transactionStates[txId].committed) {
                    continue;
                }
                transactionStates[txId].ops.push(entry);
            } else if (entry.txn === 'commit') {
                if (!transactionStates[txId] || transactionStates[txId].committed) {
                    continue;
                }
                transactionStates[txId].committed = true;
                transactionStates[txId].commitLine = currentLineNumber;
                transactionStates[txId].commitTimestamp = txTimestamp;
            } 
        } else { 
            const entryTsSource = entry.doc?.updatedAt || (Array.isArray(entry.docs) && entry.docs.length > 0 && entry.docs[0]?.updatedAt);
            let entryDateTime = entryTsSource ? Date.parse(entryTsSource) : null;
            if (entryTsSource && isNaN(entryDateTime)) {
                entryDateTime = null; 
            }

            if (cutoffDateTime && entryDateTime !== null && entryDateTime <= cutoffDateTime) {
                continue;
            }
            recoveredEntries.push(entry);
        }
    }

    for (const txid of Object.keys(transactionStates)) {
        const state = transactionStates[txid];
        if (state.committed) {
            if (cutoffDateTime && state.commitTimestamp && state.commitTimestamp <= cutoffDateTime) {
                continue;
            }
            for (const op of state.ops) {
                recoveredEntries.push({ ...op, _txn_applied_from_wal: true, _tx_origin_id: txid });
            }
        } else {
            logger.warn(`[WAL] Транзакция ${txid} (начата на строке ${state.startLine}) в ${walPath} не завершена (нет COMMIT) и проигнорирована.`);
        }
    }
    
    const logMsg = `[WAL] Завершено чтение ${walPath}. Обработано строк: ${lines.length}. Записей для применения: ${recoveredEntries.length}.` +
                   (sinceTimestamp ? ` (Фильтр по времени: после ${sinceTimestamp})` : ``);
    
    if (effectiveOptions.isInitialLoad) { 
         logger.log(logMsg.replace('[WAL]', '[WAL Init]'));
    }

    return recoveredEntries;
}

async function compactWal(walPath, checkpointTimestamp = null) {
    if (!checkpointTimestamp) {
        return;
    }

    let checkpointTimeNum;
    try {
        checkpointTimeNum = Date.parse(checkpointTimestamp);
        if (isNaN(checkpointTimeNum)) {
            logger.error(`[WAL] Невалидный checkpointTimestamp '${checkpointTimestamp}' при компакции WAL ${walPath}. ОТМЕНА.`);
            return;
        }
    } catch (e) {
        logger.error(`[WAL] Ошибка парсинга checkpointTimestamp '${checkpointTimestamp}' (${e.message}) при компакции WAL ${walPath}. ОТМЕНА.`);
        return;
    }
    
    const allCurrentWalEntries = await readWal(walPath, null, { recover: true, strict: false });
    const entriesToKeep = [];
    
    for (const entry of allCurrentWalEntries) {
        let entryTime = null;
        if (entry._txn_applied_from_wal && entry.ts) { 
            entryTime = Date.parse(entry.ts);
        } else if (!entry.txn) { 
             const entryTsSource = entry.doc?.updatedAt || (Array.isArray(entry.docs) && entry.docs.length > 0 && entry.docs[0]?.updatedAt);
             entryTime = entryTsSource ? Date.parse(entryTsSource) : null;
        }

        if (entryTime !== null && !isNaN(entryTime)) {
            if (entryTime > checkpointTimeNum) {
                entriesToKeep.push(entry);
            }
        } else if (isNaN(entryTime) && (entry.doc?.updatedAt || (Array.isArray(entry.docs) && entry.docs[0]?.updatedAt) || entry.ts)) {
            // logger.warn(`[WAL Compact] Запись с невалидным timestamp в ${walPath} не будет сохранена.`);
        }
    }

    const cleanEntriesToKeep = entriesToKeep.map(e => {
        const { _txn_applied_from_wal, _tx_origin_id, ...rest } = e;
        return rest;
    });

    const newWalContent = cleanEntriesToKeep.map(e => JSON.stringify(e)).join('\n') + (cleanEntriesToKeep.length > 0 ? '\n' : '');
    
    let attempt = 0;
    const maxAttempts = 3;
    while (true) {
        try {
            await fs.writeFile(walPath, newWalContent, 'utf8');
            let fileHandleCompact; 
            try {
                fileHandleCompact = await fs.open(walPath, 'r+');
                await fileHandleCompact.sync(); // ИЗМЕНЕНИЕ: fsync -> sync
            } catch (syncErr) {
                logger.warn(`[WAL] Ошибка sync после перезаписи WAL ${walPath} при компакции: ${syncErr.message}`);
            } finally {
                if (fileHandleCompact !== undefined) {
                    // ИЗМЕНЕНИЕ: fileHandleCompact.close() остается, т.к. это метод объекта FileHandle
                    await fileHandleCompact.close().catch(closeErr => logger.warn(`[WAL] Ошибка закрытия fileHandle WAL ${walPath} после sync в compactWal: ${closeErr.message}`));
                }
            }
            logger.log(`[WAL] Компакция WAL для ${walPath} завершена. Осталось ${cleanEntriesToKeep.length} записей (было до фильтрации: ${allCurrentWalEntries.length}).`);
            break;
        } catch (err) {
            attempt++;
            if (attempt < maxAttempts) {
                await delay(100 * attempt);
            } else {
                logger.error(`[WAL] КРИТ. ОШИБКА перезаписи WAL ${walPath} при компакции (после ${maxAttempts} попыток): ${err.message}.`);
                break; 
            }
        }
    }
}

module.exports = {
    getWalPath,
    initializeWal,
    readWal,
    compactWal,
    appendWalEntry,
    writeTransactionBlock
};