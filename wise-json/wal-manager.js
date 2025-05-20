// wise-json/wal-manager.js
const fs = require('fs/promises');
const path = require('path');
const { pathExists, ensureDirectoryExists } = require('./storage-utils.js');

const WAL_FILE_SUFFIX = '.wal.jsonl';
const WAL_PROCESSING_SUFFIX = '.processing_for_checkpoint';

// Вспомогательная функция для задержки
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Возвращает стандартный путь к WAL-файлу для коллекции.
 * @param {string} collectionDirPath - Путь к директории коллекции.
 * @param {string} collectionName - Имя коллекции.
 * @returns {string}
 */
function getWalPath(collectionDirPath, collectionName) {
    return path.join(collectionDirPath, `${collectionName}${WAL_FILE_SUFFIX}`);
}

/**
 * Инициализирует WAL. На данном этапе просто проверяет существование директории коллекции.
 * @param {string} walPath - Полный путь к WAL-файлу (используется для получения dirname, если collectionDirPath не передан).
 * @param {string} collectionDirPath - Путь к директории коллекции (для ensureDirectoryExists).
 * @returns {Promise<void>}
 */
async function initializeWal(walPath, collectionDirPath) {
    // walDir обычно совпадает с collectionDirPath, так как WAL лежит в папке коллекции
    const dirToEnsure = collectionDirPath || path.dirname(walPath); 
    await ensureDirectoryExists(dirToEnsure);
}

/**
 * Записывает одну операцию в WAL-файл.
 * Временная метка 'ts' должна быть уже установлена в operationEntry вызывающим кодом.
 * @param {string} walPath - Полный путь к WAL-файлу.
 * @param {object} operationEntry - Объект операции для записи (например, {op: 'INSERT', doc: {...}, ts: '...'}).
 * @param {boolean} [forceSync=false] - Если true, вызывает fsync для гарантии записи на диск.
 * @returns {Promise<void>}
 * @throws {Error} Если произошла ошибка записи или отсутствует временная метка в operationEntry.
 */
async function appendToWal(walPath, operationEntry, forceSync = false) {
    if (!operationEntry.ts) {
        const errMsg = `WalManager: Попытка записи в WAL для операции '${operationEntry.op}' БЕЗ временной метки (ts). Это критическая ошибка.`;
        console.error(errMsg, operationEntry);
        throw new Error(errMsg); 
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

/**
 * Читает все валидные операции из WAL-файла.
 * @param {string} walPath - Полный путь к WAL-файлу.
 * @param {string} [sinceTs] - Необязательная временная метка (ISO строка). Если указана,
 *                             будут возвращены только операции с ts >= sinceTs (включая).
 * @returns {Promise<Array<object>>} Массив объектов операций.
 * @throws {Error} Если произошла ошибка чтения файла (кроме ENOENT).
 */
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
                console.warn(`WalManager: Пропущена неполная или поврежденная запись в WAL "${walPath}" (отсутствует op или ts): ${line.substring(0,100)}...`);
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
 * Основной WAL-файл становится доступным для новых записей (создается пустым, если его не было).
 * @param {string} mainWalPath - Путь к основному WAL-файлу.
 * @param {string} processingAttemptTs - Временная метка (ISO строка) для именования временного WAL.
 * @returns {Promise<string>} Путь к временному WAL-файлу, который нужно обработать (`walToProcessPath`).
 * @throws {Error} Если не удалось переименовать существующий WAL или создать/обеспечить новый основной WAL.
 */
async function prepareWalForCheckpoint(mainWalPath, processingAttemptTs) {
    const sanitizedTs = processingAttemptTs.replace(/[:.]/g, '-'); 
    const walToProcessPath = `${mainWalPath}${WAL_PROCESSING_SUFFIX}_${sanitizedTs}`;
    
    if (await pathExists(mainWalPath)) {
        try {
            await fs.rename(mainWalPath, walToProcessPath);
            console.log(`WalManager: Текущий WAL "${path.basename(mainWalPath)}" переименован в "${path.basename(walToProcessPath)}" для обработки чекпоинтом.`);
        } catch (renameError) {
            const errMsg = `WalManager: Не удалось переименовать WAL "${mainWalPath}" в "${walToProcessPath}": ${renameError.message}`;
            console.error(errMsg, renameError.stack);
            throw new Error(errMsg);
        }
    } else {
        console.log(`WalManager: Основной WAL "${path.basename(mainWalPath)}" не найден при подготовке к чекпоинту. Создаем пустой "${path.basename(walToProcessPath)}" для обработки.`);
        try {
            await fs.writeFile(walToProcessPath, '', 'utf-8');
        } catch (e) {
            const m = `WalManager: Не удалось создать пустой временный WAL "${walToProcessPath}": ${e.message}`;
            console.error(m, e.stack);
            throw new Error(m);
        }
    }

    try {
        const handle = await fs.open(mainWalPath, 'a'); 
        await handle.close();
    } catch (createError) {
        const e = `WalManager: Не удалось создать/обеспечить существование нового основного WAL "${mainWalPath}" после переименования старого: ${createError.message}`;
        console.error(e, createError.stack);
        throw new Error(e);
    }
    return walToProcessPath;
}

/**
 * Завершает обработку WAL после успешного чекпоинта.
 * Читает временный WAL (`walToProcessPath`), отбирает из него операции, которые строго новее (`>`)
 * временной метки успешно сохраненного чекпоинта, и объединяет их с текущим содержимым основного WAL.
 * Затем временный WAL (`walToProcessPath`) удаляется.
 * @param {string} mainWalPath - Путь к основному (текущему) WAL-файлу.
 * @param {string} walToProcessPath - Путь к временному WAL-файлу, который был заархивирован для чекпоинта.
 * @param {string} actualCheckpointTimestamp - Точная временная метка (ISO строка), когда чекпоинт был успешно сохранен.
 * @param {boolean} walForceSync - Применять ли fsync при перезаписи `mainWalPath`.
 * @returns {Promise<number>} Количество операций, которые были отфильтрованы из `walToProcessPath` и добавлены к `mainWalPath`.
 * @throws {Error} Если произошла критическая ошибка.
 */
async function finalizeWalAfterCheckpoint(mainWalPath, walToProcessPath, actualCheckpointTimestamp, walForceSync) {
    let operationsKeptFromProcessedWalCount = 0;
    if (!(await pathExists(walToProcessPath))) {
        console.log(`WalManager: Временный WAL "${path.basename(walToProcessPath)}" не найден для финализации. Пропуск.`);
        return operationsKeptFromProcessedWalCount;
    }

    // Уникальное имя для временного файла, в который будет собираться новый основной WAL
    const tempFinalWalPath = `${mainWalPath}.${Date.now()}.${Math.random().toString(36).substring(2,7)}.finalizing.tmp`;
    
    try {
        const entriesFromProcessedWal = await readWal(walToProcessPath); 
        // Отбираем записи из обработанного WAL, которые строго новее метки чекпоинта
        const entriesToKeepInNewWal = entriesFromProcessedWal.filter(entry => entry.ts > actualCheckpointTimestamp);
        operationsKeptFromProcessedWalCount = entriesToKeepInNewWal.length;

        let currentMainWalLines = [];
        if (await pathExists(mainWalPath)) {
            const currentMainWalContent = await fs.readFile(mainWalPath, 'utf-8');
            if (currentMainWalContent.trim() !== '') {
                currentMainWalLines = currentMainWalContent.trim().split('\n');
            }
        }
        
        const linesToKeepInNewWalAsJsonStrings = entriesToKeepInNewWal.map(entry => JSON.stringify(entry));
        // Объединяем существующие строки в mainWalPath (которые могли появиться во время чекпоинта)
        // с отфильтрованными строками из walToProcessPath.
        const combinedLines = [...currentMainWalLines, ...linesToKeepInNewWalAsJsonStrings];
        
        const finalNewWalContent = combinedLines.length > 0 ? combinedLines.join('\n') + '\n' : '';
        
        // Записываем объединенное содержимое во временный файл
        await fs.writeFile(tempFinalWalPath, finalNewWalContent, 'utf-8');
        if (walForceSync && finalNewWalContent.length > 0) { 
            let tempHandle;
            try {
                tempHandle = await fs.open(tempFinalWalPath, 'r+'); 
                await tempHandle.sync();
            } finally {
                if (tempHandle) await tempHandle.close();
            }
        }

        if (operationsKeptFromProcessedWalCount > 0) {
            console.log(`WalManager: ${operationsKeptFromProcessedWalCount} операций из "${path.basename(walToProcessPath)}" (новее ${actualCheckpointTimestamp}) будут объединены с текущим основным WAL.`);
        }

        // Безопасно заменяем основной WAL-файл содержимым tempFinalWalPath
        let attempts = 0; 
        const MAX_RENAME_ATTEMPTS = 5; 
        const RENAME_DELAY_MS = 200;
        while (attempts < MAX_RENAME_ATTEMPTS) {
            try {
                await fs.rename(tempFinalWalPath, mainWalPath);
                console.log(`WalManager: Основной WAL "${path.basename(mainWalPath)}" успешно обновлен/финализирован.`);
                break; 
            } catch (renameError) {
                attempts++;
                if ((renameError.code === 'EPERM' || renameError.code === 'EBUSY') && attempts < MAX_RENAME_ATTEMPTS) {
                    console.warn(`WalManager: Попытка ${attempts}/${MAX_RENAME_ATTEMPTS} rename основного WAL "${tempFinalWalPath}" -> "${mainWalPath}" (${renameError.code}). Повтор ${RENAME_DELAY_MS} мс.`);
                    await delay(RENAME_DELAY_MS);
                } else {
                    console.error(`WalManager: Не удалось rename временный основной WAL "${tempFinalWalPath}" в "${mainWalPath}" после ${attempts} попыток. ${renameError.message}`);
                    // Пытаемся удалить временный файл перед тем, как бросить ошибку, чтобы не оставлять мусор
                    if (await pathExists(tempFinalWalPath)) {
                        try { await fs.unlink(tempFinalWalPath); } 
                        catch(e) { console.warn(`WalManager: Не удалось удалить ${tempFinalWalPath} после ошибки rename: ${e.message}`)}
                    }
                    throw renameError; // Перебрасываем ошибку переименования
                }
            }
        }
        
        // Удаляем обработанный временный WAL (который был *.processing_for_checkpoint)
        try {
            await fs.unlink(walToProcessPath);
            console.log(`WalManager: Временный (обработанный) WAL "${path.basename(walToProcessPath)}" успешно удален.`);
        } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') { // Игнорируем, если файл уже удален или не был создан (если был пуст)
                console.error(`WalManager: Не удалось удалить обработанный временный WAL "${path.basename(walToProcessPath)}": ${unlinkError.message}`);
            }
        }
        return operationsKeptFromProcessedWalCount; // Возвращаем количество операций, которые были ДОБАВЛЕНЫ из старого WAL

    } catch (error) {
        const errorMessage = `WalManager: Критическая ошибка при финализации WAL (обработка "${path.basename(walToProcessPath)}"): ${error.message}`;
        console.error(errorMessage, error.stack);
        // Если создавался tempFinalWalPath, пытаемся его удалить
        if (await pathExists(tempFinalWalPath)) {
            try { await fs.unlink(tempFinalWalPath); } 
            catch (e) { console.warn(`WalManager: Не удалось удалить ${tempFinalWalPath} после ошибки финализации: ${e.message}`)}
        }
        // walToProcessPath содержит важные данные, которые не удалось обработать, НЕ удаляем его автоматически.
        console.warn(`WalManager: Временный WAL "${path.basename(walToProcessPath)}" СОХРАНЕН из-за ошибки финализации для ручного анализа.`);
        throw new Error(errorMessage); // Перебрасываем агрегированную ошибку
    }
}

module.exports = {
    getWalPath,
    initializeWal,
    appendToWal,
    readWal,
    prepareWalForCheckpoint,
    finalizeWalAfterCheckpoint,
};