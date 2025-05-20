// wise-json/wal-manager.js
const fs = require('fs/promises');
const path = require('path');
const { pathExists, ensureDirectoryExists } = require('./storage-utils.js');

const WAL_FILE_SUFFIX = '.wal.jsonl';
const WAL_PROCESSING_SUFFIX = '.processing_for_checkpoint';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getWalPath(collectionDirPath, collectionName) {
    return path.join(collectionDirPath, `${collectionName}${WAL_FILE_SUFFIX}`);
}

async function initializeWal(walPath, collectionDirPath) {
    const walDir = collectionDirPath; 
    await ensureDirectoryExists(walDir);
}

async function appendToWal(walPath, operationEntry, forceSync = false) {
    if (!operationEntry.ts) {
        operationEntry.ts = new Date().toISOString();
    }
    const line = JSON.stringify(operationEntry) + '\n';
    let fileHandle;
    try {
        fileHandle = await fs.open(walPath, 'a');
        await fileHandle.appendFile(line, 'utf-8');
        if (forceSync) {
            await fileHandle.sync();
        }
    } catch (error) {
        const errorMessage = `WalManager: Ошибка записи в WAL "${walPath}": ${error.message}`;
        console.error(errorMessage, error.stack);
        throw new Error(errorMessage);
    } finally {
        if (fileHandle) {
            try {
                await fileHandle.close();
            } catch (closeError) {
                console.error(`WalManager: Ошибка при закрытии WAL-файла "${walPath}" после записи: ${closeError.message}`);
            }
        }
    }
}

async function readWal(walPath, sinceTs) {
    const operations = [];
    if (!(await pathExists(walPath))) {
        return operations;
    }

    let content;
    try {
        content = await fs.readFile(walPath, 'utf-8');
    } catch (error) {
        const errorMessage = `WalManager: Ошибка чтения WAL "${walPath}": ${error.message}`;
        console.error(errorMessage, error.stack);
        throw new Error(errorMessage);
    }

    const lines = content.split('\n');
    for (const line of lines) {
        if (line.trim() === '') continue;
        try {
            const entry = JSON.parse(line);
            if (!entry.op || !entry.ts) {
                console.warn(`WalManager: Пропущена неполная или поврежденная запись в WAL "${walPath}": ${line.substring(0,100)}...`);
                continue;
            }
            if (sinceTs && entry.ts < sinceTs) {
                continue;
            }
            operations.push(entry);
        } catch (parseError) {
            console.error(`WalManager: Ошибка парсинга JSON в записи WAL "${walPath}": "${line.substring(0, 100)}...". Запись пропущена. Ошибка: ${parseError.message}`);
        }
    }
    return operations;
}

/**
 * Подготавливает WAL к чекпоинту: переименовывает текущий WAL во временный файл для обработки.
 * Основной WAL-файл становится доступным для новых записей (или создается пустым).
 * @param {string} mainWalPath - Путь к основному WAL-файлу.
 * @param {string} processingAttemptTs - Временная метка для именования временного WAL.
 * @returns {Promise<string>} Путь к временному WAL-файлу, который нужно обработать (`walToProcessPath`).
 * @throws {Error} Если не удалось переименовать или создать новый WAL.
 */
async function prepareWalForCheckpoint(mainWalPath, processingAttemptTs) {
    const walToProcessPath = `${mainWalPath}${WAL_PROCESSING_SUFFIX}_${processingAttemptTs.replace(/[:.]/g, '-')}`;
    
    if (await pathExists(mainWalPath)) {
        try {
            await fs.rename(mainWalPath, walToProcessPath);
            console.log(`WalManager: Текущий WAL "${mainWalPath}" переименован в "${walToProcessPath}" для обработки чекпоинтом.`);
        } catch (renameError) {
            const errMsg = `WalManager: Не удалось переименовать WAL "${mainWalPath}" в "${walToProcessPath}": ${renameError.message}`;
            console.error(errMsg, renameError.stack);
            throw new Error(errMsg);
        }
    } else {
        // Если основного WAL нет, значит, и обрабатывать нечего.
        // Но мы все равно возвращаем имя, по которому его можно было бы найти, чтобы вызывающий код не упал.
        // Однако, это означает, что walToProcessPath не будет существовать.
        console.log(`WalManager: Основной WAL "${mainWalPath}" не найден при подготовке к чекпоинту. Предполагается, что нет WAL для обработки.`);
        // Создадим пустой walToProcessPath, чтобы последующие операции не падали, если его ожидают
        try {
            await fs.writeFile(walToProcessPath, '', 'utf-8');
        } catch (e) { /* игнорируем, если даже это не удалось */ }
    }

    // Гарантируем, что основной WAL-файл существует для новых записей (даже если он пустой)
    try {
        // Попытка открыть в режиме 'a' создаст файл, если его нет
        const handle = await fs.open(mainWalPath, 'a');
        await handle.close();
    } catch (createError) {
        const errMsg = `WalManager: Не удалось создать/обеспечить существование нового WAL "${mainWalPath}": ${createError.message}`;
        console.error(errMsg, createError.stack);
        throw new Error(errMsg);
    }

    return walToProcessPath;
}


/**
 * Завершает обработку WAL после успешного чекпоинта.
 * Читает временный WAL (`walToProcessPath`), отбирает из него операции, которые произошли *после*
 * фактического времени фиксации чекпоинта, и дописывает их в текущий основной WAL.
 * Затем временный WAL удаляется.
 * @param {string} mainWalPath - Путь к основному (текущему) WAL-файлу.
 * @param {string} walToProcessPath - Путь к временному WAL-файлу, который был заархивирован для чекпоинта.
 * @param {string} actualCheckpointTimestamp - Точная временная метка, когда чекпоинт был успешно сохранен (ts из метаданных чекпоинта).
 *                                           Операции из walToProcessPath с ts >= actualCheckpointTimestamp будут дописаны в mainWalPath.
 * @param {boolean} walForceSync - Применять ли fsync при дописывании.
 * @returns {Promise<number>} Количество операций, перенесенных в основной WAL.
 * @throws {Error} Если произошла критическая ошибка.
 */
async function finalizeWalAfterCheckpoint(mainWalPath, walToProcessPath, actualCheckpointTimestamp, walForceSync) {
    let operationsMoved = 0;
    if (!(await pathExists(walToProcessPath))) {
        console.log(`WalManager: Временный WAL "${walToProcessPath}" не найден для финализации. Пропуск.`);
        return operationsMoved;
    }

    try {
        const entriesFromProcessedWal = await readWal(walToProcessPath, actualCheckpointTimestamp);
        
        if (entriesFromProcessedWal.length > 0) {
            console.log(`WalManager: Обнаружено ${entriesFromProcessedWal.length} операций в "${walToProcessPath}", которые новее чекпоинта (ts: ${actualCheckpointTimestamp}). Перенос в основной WAL "${mainWalPath}".`);
            for (const entry of entriesFromProcessedWal) {
                await appendToWal(mainWalPath, entry, walForceSync); // Добавляем в текущий основной WAL
                operationsMoved++;
            }
        }

        // Удаляем обработанный временный WAL
        try {
            await fs.unlink(walToProcessPath);
            console.log(`WalManager: Временный WAL "${walToProcessPath}" успешно удален.`);
        } catch (unlinkError) {
            console.error(`WalManager: Не удалось удалить обработанный временный WAL "${walToProcessPath}": ${unlinkError.message}`);
            // Это не критично для консистентности данных, но может оставить мусор.
        }
        return operationsMoved;
    } catch (error) {
        const errorMessage = `WalManager: Ошибка при финализации WAL после чекпоинта (обработка "${walToProcessPath}"): ${error.message}`;
        console.error(errorMessage, error.stack);
        // Если здесь ошибка, возможно, не все "свежие" записи из walToProcessPath были перенесены.
        // Это рискованная ситуация.
        throw new Error(errorMessage);
    }
}


module.exports = {
    getWalPath,
    initializeWal,
    appendToWal,
    readWal,
    // Убираем старый processWalAfterCheckpoint, заменяем двумя новыми функциями
    prepareWalForCheckpoint,
    finalizeWalAfterCheckpoint,
};