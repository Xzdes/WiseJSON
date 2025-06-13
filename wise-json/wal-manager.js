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
            // Убедимся, что текст заканчивается переносом строки, если его там нет
            const lineToWrite = text.endsWith('\n') ? text : text + '\n';
            await fs.appendFile(walPath, lineToWrite, 'utf8');
            return;
        } catch (err) {
            lastErr = err;
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
    logger.error(`[WAL] Ошибка appendFile для WAL '${walPath}' (после ${retries + 1} попыток): ${lastErr?.message}`);
    throw lastErr;
}

/**
 * Записать новую запись в WAL с retry.
 * @param {string} walPath
 * @param {object} entry
 * @param {number} [retries]
 * @returns {Promise<void>}
 */
async function appendWalEntry(walPath, entry, retries = 5) {
    try {
        // JSON.stringify(entry) + '\n' - перенос строки уже учтен в appendFileWithRetry
        await appendFileWithRetry(walPath, JSON.stringify(entry), retries);
    } catch (err) {
        logger.error(`[WAL] Критическая ошибка записи WAL-записи в ${walPath}: ${err.message}`);
        throw err; // Пробрасываем, т.к. это критично
    }
}

/**
 * Чтение WAL-файла.
 * @param {string} walPath
 * @param {string|null} sinceTimestamp - ISO timestamp, только записи ПОСЛЕ него.
 * @param {object} [options] - { strict: boolean, onError: (err, line, lineNum) => void, recover: boolean }
 * @returns {Promise<Array<Object>>}
 */
async function readWal(walPath, sinceTimestamp = null, options = {}) {
    const effectiveOptions = { strict: false, recover: false, ...options };
    let rawContent;
    try {
        rawContent = await fs.readFile(walPath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') {
            // logger.debug(`[WAL] Файл WAL ${walPath} не найден, возвращаем пустой массив.`);
            return [];
        }
        logger.error(`[WAL] Критическая ошибка чтения файла WAL ${walPath}: ${e.message}`);
        throw e;
    }

    const lines = rawContent.trim().split('\n');
    const recoveredEntries = [];
    const transactionStates = {}; // { txid: { ops: [], committed: false, startLine: number, commitLine?: number } }
    
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

    // logger.debug(`[WAL] Чтение ${walPath}. Опции: ${JSON.stringify(effectiveOptions)}. Всего строк для обработки: ${lines.length}. CutoffTime: ${cutoffDateTime ? new Date(cutoffDateTime).toISOString() : 'N/A'}`);

    for (const [idx, line] of lines.entries()) {
        const currentLineNumber = idx + 1;
        if (currentLineNumber > 0 && currentLineNumber % 50000 === 0) {
            logger.debug(`[WAL] Обработано ${currentLineNumber} строк из ${lines.length} в ${walPath}...`);
        }

        if (!line.trim()) {
            // logger.debug(`[WAL] Пропущена пустая или пробельная строка ${currentLineNumber} в ${walPath}.`);
            continue;
        }

        const MAX_LINE_LEN = 20 * 1024 * 1024; // 20MB лимит на строку JSON
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
                try {
                    effectiveOptions.onError(e, line, currentLineNumber);
                } catch (userCallbackError) {
                    logger.error(`[WAL] Ошибка в пользовательском onError callback при обработке строки ${currentLineNumber}: ${userCallbackError.message}`);
                }
            }

            if (effectiveOptions.strict) {
                logger.error(errorContext + ` Содержимое (начало): "${linePreview}" (strict mode).`);
                throw new Error(errorContext + ` (strict mode).`);
            }
            // В режиме recover или по умолчанию (не strict) - логируем и пропускаем
            logger.warn(errorContext + ` Содержимое (начало): "${linePreview}" (строка пропущена).`);
            continue;
        }

        // Валидация базовой структуры entry
        if (typeof entry !== 'object' || entry === null) {
            logger.warn(`[WAL] Запись на строке ${currentLineNumber} в ${walPath} не является объектом после парсинга. Пропущена.`);
            continue;
        }
        
        // Обработка транзакционных записей
        if (entry.txn) {
            const txTimestamp = entry.ts ? Date.parse(entry.ts) : null;
            const txId = entry.id || entry.txid; // 'id' для start/commit, 'txid' для op

            if (!txId) {
                logger.warn(`[WAL] Транзакционная запись '${entry.txn}' без ID/txid на строке ${currentLineNumber} в ${walPath}. Игнорируется.`);
                continue;
            }

            if (entry.txn === 'start') {
                if (transactionStates[txId]) {
                     logger.warn(`[WAL] Повторная TXN_START для ID '${txId}' на строке ${currentLineNumber} в ${walPath} (предыдущий старт на ${transactionStates[txId].startLine}). Предыдущая транзакция будет отменена.`);
                }
                transactionStates[txId] = { ops: [], committed: false, startLine: currentLineNumber, timestamp: txTimestamp };
            } else if (entry.txn === 'op') {
                if (!transactionStates[txId]) {
                    logger.warn(`[WAL] TXN_OP для неизвестной транзакции ID '${txId}' на строке ${currentLineNumber} в ${walPath}. Игнорируется.`);
                    continue;
                }
                if (transactionStates[txId].committed) {
                    logger.warn(`[WAL] TXN_OP для уже завершенной (committed) транзакции ID '${txId}' на строке ${currentLineNumber} в ${walPath}. Игнорируется.`);
                    continue;
                }
                transactionStates[txId].ops.push(entry);
            } else if (entry.txn === 'commit') {
                if (!transactionStates[txId]) {
                    logger.warn(`[WAL] TXN_COMMIT для неизвестной транзакции ID '${txId}' на строке ${currentLineNumber} в ${walPath}. Игнорируется.`);
                    continue;
                }
                if (transactionStates[txId].committed) {
                     logger.warn(`[WAL] Повторный TXN_COMMIT для ID '${txId}' на строке ${currentLineNumber} в ${walPath} (предыдущий коммит на ${transactionStates[txId].commitLine}). Игнорируется.`);
                     continue;
                }
                transactionStates[txId].committed = true;
                transactionStates[txId].commitLine = currentLineNumber;
                transactionStates[txId].commitTimestamp = txTimestamp; // Сохраняем время коммита
            } else {
                logger.warn(`[WAL] Неизвестный тип транзакционной записи '${entry.txn}' (ID: ${txId}) на строке ${currentLineNumber} в ${walPath}. Игнорируется.`);
            }
        } else { // Обычная (не транзакционная) операция
            const entryTsSource = entry.doc?.updatedAt || (Array.isArray(entry.docs) && entry.docs.length > 0 && entry.docs[0]?.updatedAt);
            let entryDateTime = entryTsSource ? Date.parse(entryTsSource) : null;
            if (entryTsSource && isNaN(entryDateTime)) {
                logger.warn(`[WAL] Невалидный timestamp '${entryTsSource}' в обычной записи на строке ${currentLineNumber} в ${walPath}.`);
                entryDateTime = null; // Не можем использовать для фильтрации
            }

            if (cutoffDateTime && entryDateTime !== null && entryDateTime <= cutoffDateTime) {
                // logger.debug(`[WAL] Обычная запись на строке ${currentLineNumber} (ts: ${new Date(entryDateTime).toISOString()}) пропущена из-за cutoffTime.`);
                continue;
            }
            recoveredEntries.push(entry);
        }
    }

    // Добавляем операции из коммиченных транзакций, учитывая cutoffTime для всей транзакции (по времени коммита)
    for (const txid of Object.keys(transactionStates)) {
        const state = transactionStates[txid];
        if (state.committed) {
            // Если есть cutoffTime, и время коммита транзакции ДО или РАВНО cutoffTime, пропускаем всю транзакцию
            if (cutoffDateTime && state.commitTimestamp && state.commitTimestamp <= cutoffDateTime) {
                // logger.debug(`[WAL] Транзакция ${txid} (commit_ts: ${new Date(state.commitTimestamp).toISOString()}) пропущена целиком из-за cutoffTime.`);
                continue;
            }
            // logger.debug(`[WAL] Добавление ${state.ops.length} операций из коммиченной транзакции ${txid} (старт: ${state.startLine}, коммит: ${state.commitLine}) в ${walPath}.`);
            for (const op of state.ops) {
                recoveredEntries.push({ ...op, _txn_applied_from_wal: true, _tx_origin_id: txid });
            }
        } else {
            logger.warn(`[WAL] Транзакция ${txid} (начата на строке ${state.startLine}) в ${walPath} не была завершена (нет TXN_COMMIT) и будет проигнорирована.`);
        }
    }
    
    const logMsg = `[WAL] Завершено чтение ${walPath}. Обработано строк: ${lines.length}. Записей для применения: ${recoveredEntries.length}.` +
                   (sinceTimestamp ? ` (Фильтр по времени: после ${sinceTimestamp})` : ` (Без фильтрации по времени)`);
    // logger.debug(logMsg);
    // logger.log заменен на debug, чтобы не спамить при успешном чтении, если это не основной лог инициализации.
    // При инициализации коллекции (core.js) будет свой лог о количестве примененных записей.
    if (options.isInitialLoad) { // Флаг, который можно передать из Collection._initialize
         logger.log(logMsg.replace('[WAL] ', '[WAL Init] '));
    } else {
         logger.debug(logMsg);
    }


    return recoveredEntries;
}


/**
 * Компакция WAL: после успешного checkpoint удаляет старые операции из WAL (до чекпоинта).
 * @param {string} walPath
 * @param {string|null} checkpointTimestamp - Timestamp последнего успешного чекпоинта.
 * @returns {Promise<void>}
 */
async function compactWal(walPath, checkpointTimestamp = null) {
    if (!checkpointTimestamp) {
        logger.warn(`[WAL] Компакция WAL для ${walPath} пропущена: checkpointTimestamp не предоставлен.`);
        return;
    }

    let checkpointTimeNum;
    try {
        checkpointTimeNum = Date.parse(checkpointTimestamp);
        if (isNaN(checkpointTimeNum)) {
            logger.error(`[WAL] Невалидный checkpointTimestamp '${checkpointTimestamp}' при компакции WAL для ${walPath}. Компакция ОТМЕНЕНА.`);
            return;
        }
    } catch (e) {
        logger.error(`[WAL] Ошибка парсинга checkpointTimestamp '${checkpointTimestamp}' (${e.message}) при компакции WAL для ${walPath}. Компакция ОТМЕНЕНА.`);
        return;
    }

    // Читаем ВСЕ записи из WAL, пытаясь восстановить максимум.
    // Опции strict/recover здесь можно брать из глобальных настроек БД или использовать безопасные дефолты.
    // Для компакции важно прочитать всё, что можно, чтобы не потерять "будущие" записи.
    const allCurrentWalEntries = await readWal(walPath, null, { recover: true, strict: false });
    
    const entriesToKeep = [];
    const processedTxnForCompaction = new Set(); // Чтобы не дублировать операции из транзакций

    for (const entry of allCurrentWalEntries) {
        if (entry._txn_applied_from_wal && entry._tx_origin_id) {
            // Это операция из уже обработанной транзакции
            if (processedTxnForCompaction.has(entry._tx_origin_id)) continue; // Уже обработали эту транзакцию

            const txState = {}; // Временное состояние для оценки времени транзакции (нужно время коммита)
                            // Это упрощение, т.к. readWal уже вернул только операции из коммиченных.
                            // Нам нужен timestamp коммита этой транзакции, чтобы сравнить с checkpointTimeNum.
                            // Этой информации в `entry` напрямую нет.
                            // Это усложняет точную фильтрацию транзакций при компакции.
            
            // ПРОСТОЙ ПОДХОД: если операция из транзакции, и ее собственный `ts` (время записи операции в WAL) ПОСЛЕ чекпоинта, сохраняем.
            // Это может привести к сохранению операций из транзакций, которые начались до чекпоинта, но завершились после.
            // Это безопаснее, чем их потерять.
            if (entry.ts) {
                const opTime = Date.parse(entry.ts);
                if (!isNaN(opTime) && opTime > checkpointTimeNum) {
                    entriesToKeep.push(entry);
                }
            } else {
                // Если у TXN_OP нет своего timestamp, но она часть транзакции, которая может быть "новой".
                // Сложно решить без анализа всего блока транзакции. Безопаснее включить, если нет строгого критерия.
                // logger.debug(`[WAL Compact] TXN_OP без 'ts' в ${walPath}, рассматривается для сохранения: ${JSON.stringify(entry)}`);
                // entriesToKeep.push(entry); // ОСТОРОЖНО: может сохранить старые транзакционные операции
            }
            // Чтобы избежать дублирования операций из одной транзакции, если будем обрабатывать каждую
            // processedTxnForCompaction.add(entry._tx_origin_id); // Это неправильно здесь, нужно всю транзакцию
            continue; // Переходим к следующей записи
        }


        // Для обычных (не транзакционных) записей или для "сырых" TXN_START/COMMIT (хотя readWal их не должен возвращать в `recoveredEntries`)
        const entryTsSource = entry.ts || entry.doc?.updatedAt || (Array.isArray(entry.docs) && entry.docs.length > 0 && entry.docs[0]?.updatedAt);
        if (entryTsSource) {
            const entryTime = Date.parse(entryTsSource);
            if (!isNaN(entryTime) && entryTime > checkpointTimeNum) {
                entriesToKeep.push(entry);
            } else if (isNaN(entryTime)) {
                logger.warn(`[WAL Compact] Запись с невалидным timestamp '${entryTsSource}' в ${walPath} не будет сохранена при компакции.`);
            }
        } else if (entry.txn && (entry.txn === 'start' || entry.txn === 'commit')) {
             // Блоки TXN_START/COMMIT сами по себе не должны оставаться после readWal, если только это не часть "будущей" транзакции.
             // readWal уже должен был обработать транзакции и вернуть только их ОПЕРАЦИИ.
             // Если они тут есть, это может быть какая-то рассинхронизация.
             // logger.warn(`[WAL Compact] "Сырая" запись TXN_START/COMMIT обнаружена в ${walPath} при компакции. Это неожиданно. Запись: ${JSON.stringify(entry)}`);
        } else {
            // Запись без timestamp и не часть известной транзакции.
            // logger.debug(`[WAL Compact] Запись без timestamp в ${walPath} не будет сохранена при компакции, т.к. есть checkpointTimestamp. Запись: ${JSON.stringify(entry).substring(0,100)}`);
        }
    }

    // Удаляем _txn_applied_from_wal и _tx_origin_id перед записью, т.к. это временные флаги
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
            logger.log(`[WAL] Компакция WAL для ${walPath} завершена. Осталось ${cleanEntriesToKeep.length} записей (было до фильтрации: ${allCurrentWalEntries.length}).`);
            break;
        } catch (err) {
            attempt++;
            if (attempt < maxAttempts) {
                logger.warn(`[WAL] Ошибка при перезаписи WAL-файла ${walPath} во время компакции (попытка ${attempt}/${maxAttempts}): ${err.message}. Повтор через ${100 * attempt}ms.`);
                await delay(100 * attempt);
            } else {
                logger.error(`[WAL] КРИТИЧЕСКАЯ ОШИБКА при перезаписи WAL-файла ${walPath} во время компакции (после ${maxAttempts} попыток): ${err.message}. WAL может содержать старые данные или быть поврежден.`);
                break; 
            }
        }
    }
}

/**
 * Записать атомарный блок транзакции в WAL с retry.
 * @param {string} walPath
 * @param {string} txid
 * @param {Array<{colName,type,args,ts?:string}>} ops - операции, каждая должна иметь `ts`
 * @param {number} [retries]
 * @returns {Promise<void>}
 */
async function writeTransactionBlock(walPath, txid, ops, retries = 5) {
    const nowISO = new Date().toISOString();
    const block = [];

    // TXN_START
    block.push({ txn: 'start', id: txid, ts: nowISO });

    // TXN_OP
    for (const op of ops) {
        if (!op.ts) { // Каждая операция в транзакции должна иметь свой timestamp для восстановления
            logger.warn(`[WAL] Операция в транзакции ${txid} не имеет 'ts', будет использован общий timestamp блока.`);
        }
        block.push({
            txn: 'op',
            txid,
            col: op.colName,
            type: op.type,
            args: op.args,
            // Используем op.ts если есть, иначе общий nowISO. Это важно для readWal/compactWal.
            ts: op.ts || nowISO 
        });
    }

    // TXN_COMMIT
    block.push({ txn: 'commit', id: txid, ts: new Date().toISOString() }); // Новое время для самого коммита

    const textBlock = block.map(e => JSON.stringify(e)).join('\n'); // Не добавляем \n после каждой строки здесь, appendFileWithRetry добавит один в конце блока

    try {
        await appendFileWithRetry(walPath, textBlock, retries); // textBlock уже будет содержать \n между строками от join
    } catch (err) {
        logger.error(`[WAL] Ошибка записи транзакционного блока ${txid} (после ретраев) в ${walPath}: ${err.message}`);
        throw err;
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