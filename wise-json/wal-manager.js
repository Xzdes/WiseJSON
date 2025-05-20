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
 * @param {string} walPath - Полный путь к WAL-файлу (используется для получения dirname).
 * @param {string} collectionDirPath - Путь к директории коллекции (для ensureDirectoryExists).
 * @returns {Promise<void>}
 */
async function initializeWal(walPath, collectionDirPath) {
    // walDir обычно совпадает с collectionDirPath, так как WAL лежит в папке коллекции
    const walDir = path.dirname(walPath); 
    await ensureDirectoryExists(walDir); // Убедимся, что директория WAL (папка коллекции) существует
}

/**
 * Записывает одну операцию в WAL-файл.
 * @param {string} walPath - Полный путь к WAL-файлу.
 * @param {object} operationEntry - Объект операции для записи (например, {op: 'INSERT', doc: {...}, ts: '...'}).
 * @param {boolean} [forceSync=false] - Если true, вызывает fsync для гарантии записи на диск.
 *                                     Влияет на производительность.
 * @returns {Promise<void>}
 * @throws {Error} Если произошла ошибка записи.
 */
async function appendToWal(walPath, operationEntry, forceSync = false) {
    // Временная метка должна быть установлена вызывающим кодом (в _enqueueDataModification),
    // чтобы быть консистентной для WAL и для применения к памяти.
    // Если здесь она отсутствует, это может быть признаком проблемы в логике выше.
    if (!operationEntry.ts) {
        console.warn(`WalManager: Запись в WAL для операции '${operationEntry.op}' без временной метки (ts). Устанавливается текущее время.`);
        operationEntry.ts = new Date().toISOString();
    }
    const line = JSON.stringify(operationEntry) + '\n';
    let fileHandle;
    try {
        fileHandle = await fs.open(walPath, 'a'); // 'a' - append mode, creates if not exists
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
            // Если sinceTs предоставлен, фильтруем записи, которые строго старше.
            // Записи с ts РАВНЫМ sinceTs ВКЛЮЧАЮТСЯ (т.е. "с этой метки и новее").
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
    const sanitizedTs = processingAttemptTs.replace(/[:.]/g, '-'); // Очищаем метку для имени файла
    const walToProcessPath = `${mainWalPath}${WAL_PROCESSING_SUFFIX}_${sanitizedTs}`;
    
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
        console.log(`WalManager: Основной WAL "${mainWalPath}" не найден при подготовке к чекпоинту. Предполагается, что нет WAL для обработки (создаем пустой ${path.basename(walToProcessPath)}).`);
        try {
            // Создаем пустой файл, чтобы последующие шаги, ожидающие этот файл, не падали.
            await fs.writeFile(walToProcessPath, '', 'utf-8');
        } catch (e) {
            const errMsg = `WalManager: Не удалось создать пустой временный WAL "${walToProcessPath}": ${e.message}`;
            console.error(errMsg, e.stack);
            throw new Error(errMsg);
        }
    }

    // Гарантируем, что основной WAL-файл (mainWalPath) существует для новых записей
    try {
        const handle = await fs.open(mainWalPath, 'a'); // 'a' создаст файл, если его нет
        await handle.close();
    } catch (createError) {
        const errMsg = `WalManager: Не удалось создать/обеспечить существование нового основного WAL "${mainWalPath}" после переименования старого: ${createError.message}`;
        console.error(errMsg, createError.stack);
        throw new Error(errMsg);
    }

    return walToProcessPath;
}

/**
 * Завершает обработку WAL после успешного чекпоинта.
 * Читает временный WAL (`walToProcessPath`), отбирает из него операции, которые строго новее (`>`)
 * временной метки успешно сохраненного чекпоинта, и дописывает их в текущий основной WAL.
 * Затем временный WAL (`walToProcessPath`) удаляется.
 * @param {string} mainWalPath - Путь к основному (текущему) WAL-файлу.
 * @param {string} walToProcessPath - Путь к временному WAL-файлу, который был заархивирован для чекпоинта.
 * @param {string} actualCheckpointTimestamp - Точная временная метка (ISO строка), когда чекпоинт был успешно сохранен.
 * @param {boolean} walForceSync - Применять ли fsync при дописывании "свежих" операций в `mainWalPath`.
 * @returns {Promise<number>} Количество операций, перенесенных (дописанных) в основной WAL.
 * @throws {Error} Если произошла критическая ошибка.
 */
async function finalizeWalAfterCheckpoint(mainWalPath, walToProcessPath, actualCheckpointTimestamp, walForceSync) {
    let operationsMovedCount = 0;
    if (!(await pathExists(walToProcessPath))) {
        console.log(`WalManager: Временный WAL "${walToProcessPath}" не найден для финализации (возможно, был пуст и не создавался или уже удален). Пропуск.`);
        return operationsMovedCount;
    }

    const tempFinalWalPath = `${mainWalPath}.${Date.now()}.${Math.random().toString(36).substring(2,7)}.finalizing.tmp`;

    try {
        const entriesFromProcessedWal = await readWal(walToProcessPath); 
        
        // Фильтруем записи, которые должны остаться: те, что СТРОГО новее метки времени чекпоинта.
        // Операции с ts РАВНЫМ actualCheckpointTimestamp считаются вошедшими в чекпоинт и не переносятся.
        const entriesToKeep = entriesFromProcessedWal.filter(entry => entry.ts > actualCheckpointTimestamp);

        if (entriesToKeep.length > 0) {
            console.log(`WalManager: Обнаружено ${entriesToKeep.length} операций в "${path.basename(walToProcessPath)}", которые строго новее чекпоинта (ts: ${actualCheckpointTimestamp}). Перенос в основной WAL "${path.basename(mainWalPath)}".`);
            // Дописываем эти записи в КОНЕЦ существующего mainWalPath (который мог наполниться во время чекпоинта).
            // Поэтому, мы не можем просто перезаписать mainWalPath. Мы должны дописать.
            // Однако, если mainWalPath - это новый, только что созданный файл (после prepareWalForCheckpoint), то appendFile - это то, что нужно.
            // Но если prepareWalForCheckpoint не переименовывал, а копировал, тогда mainWalPath мог наполниться.
            // При текущей логике prepareWalForCheckpoint (rename старого, создание нового пустого), mainWalPath должен быть пуст,
            // ИЛИ содержать записи, пришедшие во время чекпоинта.
            // Значит, мы должны дописать entriesToKeep к содержимому mainWalPath.
            
            // Более безопасный способ: прочитать текущий mainWalPath, добавить entriesToKeep, записать во временный, переименовать.
            let currentMainWalEntries = [];
            if (await pathExists(mainWalPath)) {
                currentMainWalEntries = await readWal(mainWalPath); // Читаем всё из текущего mainWalPath
            }
            
            const combinedEntries = [...currentMainWalEntries, ...entriesToKeep];
            
            if (combinedEntries.length > 0) {
                 const newWalContent = combinedEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
                 await fs.writeFile(tempFinalWalPath, newWalContent, 'utf-8');
            } else {
                await fs.writeFile(tempFinalWalPath, '', 'utf-8'); // Если в итоге пусто, пишем пустой
            }
            operationsMovedCount = entriesToKeep.length; // Сколько мы именно *добавили* из обработанного WAL

        } else {
            // Если из walToProcessPath нечего переносить, то mainWalPath остается как есть.
            // Но для консистентности с путем через tempFinalWalPath, мы "перезапишем" его самим собой (или пустым, если он пуст)
            // Это упрощает логику переименования ниже.
            if (await pathExists(mainWalPath)) {
                const currentMainWalContent = await fs.readFile(mainWalPath, 'utf-8');
                await fs.writeFile(tempFinalWalPath, currentMainWalContent, 'utf-8');
            } else {
                await fs.writeFile(tempFinalWalPath, '', 'utf-8');
            }
             console.log(`WalManager: В "${path.basename(walToProcessPath)}" нет операций новее чекпоинта (ts: ${actualCheckpointTimestamp}). Основной WAL "${path.basename(mainWalPath)}" не изменен записями из старого WAL.`);
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
                    console.warn(`WalManager: Попытка ${attempts}/${MAX_RENAME_ATTEMPTS} переименования основного WAL "${tempFinalWalPath}" -> "${mainWalPath}" не удалась (${renameError.code}). Повтор через ${RENAME_DELAY_MS} мс.`);
                    await delay(RENAME_DELAY_MS);
                } else {
                    console.error(`WalManager: Не удалось переименовать временный основной WAL "${tempFinalWalPath}" в "${mainWalPath}" после ${attempts} попыток. Ошибка: ${renameError.message}`);
                    if (await pathExists(tempFinalWalPath)) { 
                        try { await fs.unlink(tempFinalWalPath); } catch(e) { console.warn(`WalManager: Не удалось удалить ${tempFinalWalPath} после ошибки rename: ${e.message}`)}
                    }
                    throw renameError;
                }
            }
        }
        
        // Удаляем обработанный временный WAL (который был *.processing_for_checkpoint)
        try {
            await fs.unlink(walToProcessPath);
            console.log(`WalManager: Временный (обработанный) WAL "${path.basename(walToProcessPath)}" успешно удален.`);
        } catch (unlinkError) {
            // Если файл не найден (например, был пуст и не создавался через writeFile в prepareWalForCheckpoint), это нормально
            if (unlinkError.code !== 'ENOENT') {
                console.error(`WalManager: Не удалось удалить обработанный временный WAL "${path.basename(walToProcessPath)}": ${unlinkError.message}`);
            }
        }
        return operationsMovedCount; 
    } catch (error) {
        const errorMessage = `WalManager: Критическая ошибка при финализации WAL после чекпоинта (обработка "${path.basename(walToProcessPath)}"): ${error.message}`;
        console.error(errorMessage, error.stack);
        if (await pathExists(tempFinalWalPath)) { 
            try { await fs.unlink(tempFinalWalPath); } catch (e) { console.warn(`WalManager: Не удалось удалить ${tempFinalWalPath} после ошибки финализации: ${e.message}`)}
        }
        // walToProcessPath лучше не удалять автоматически, если здесь была ошибка, он может содержать важные данные.
        console.warn(`WalManager: Временный WAL "${path.basename(walToProcessPath)}" СОХРАНЕН из-за ошибки финализации для ручного анализа.`);
        throw new Error(errorMessage);
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