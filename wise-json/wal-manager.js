// wise-json/wal-manager.js
const fs = require('fs/promises');
const path = require('path');
const { pathExists, ensureDirectoryExists } = require('./storage-utils.js');

const WAL_FILE_SUFFIX = '.wal.jsonl';

// Вспомогательная функция для задержки
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Возвращает стандартный путь к WAL-файлу для коллекции.
 * @param {string} collectionDirPath - Путь к директории коллекции.
 * @param {string} collectionName - Имя коллекции.
 * @returns {string}
 */
function getWalPath(collectionDirPath, collectionName) {
    // WAL файл будет лежать прямо в директории коллекции
    return path.join(collectionDirPath, `${collectionName}${WAL_FILE_SUFFIX}`);
}

/**
 * Инициализирует WAL. На данном этапе просто проверяет существование директории.
 * @param {string} walPath - Полный путь к WAL-файлу. (Не используется напрямую, но может быть полезен для будущих расширений)
 * @param {string} collectionDirPath - Путь к директории, где должен находиться WAL-файл.
 * @returns {Promise<void>}
 */
async function initializeWal(walPath, collectionDirPath) {
    // walPath передается для консистентности API, но walDir получаем из collectionDirPath
    const walDir = collectionDirPath; // WAL лежит в директории коллекции
    await ensureDirectoryExists(walDir);
    // Дополнительные проверки или подготовка WAL-файла, если нужно в будущем
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
    if (!operationEntry.ts) { // Гарантируем временную метку, если она не была установлена вызывающим кодом
        operationEntry.ts = new Date().toISOString();
    }
    const line = JSON.stringify(operationEntry) + '\n';
    let fileHandle;
    try {
        // Используем fs.open и fileHandle.appendFile для возможности fsync
        fileHandle = await fs.open(walPath, 'a'); // 'a' - append mode, creates if not exists
        await fileHandle.appendFile(line, 'utf-8');
        if (forceSync) {
            await fileHandle.sync(); // Гарантирует, что данные и метаданные записаны на диск
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
                // Не перебрасываем ошибку закрытия, чтобы не маскировать возможную ошибку записи
            }
        }
    }
}

/**
 * Читает все валидные операции из WAL-файла.
 * @param {string} walPath - Полный путь к WAL-файлу.
 * @param {string} [sinceTs] - Необязательная временная метка (ISO строка). Если указана,
 *                             будут возвращены только операции с ts >= sinceTs.
 * @returns {Promise<Array<object>>} Массив объектов операций.
 * @throws {Error} Если произошла ошибка чтения файла (кроме ENOENT, когда файл просто не существует).
 */
async function readWal(walPath, sinceTs) {
    const operations = [];
    if (!(await pathExists(walPath))) {
        return operations; // WAL не существует, возвращаем пустой массив
    }

    let content;
    try {
        content = await fs.readFile(walPath, 'utf-8');
    } catch (error) {
        // ENOENT уже обработан выше проверкой pathExists
        const errorMessage = `WalManager: Ошибка чтения WAL "${walPath}": ${error.message}`;
        console.error(errorMessage, error.stack);
        throw new Error(errorMessage); // Перебрасываем ошибку чтения
    }

    const lines = content.split('\n');
    for (const line of lines) {
        if (line.trim() === '') continue; // Пропускаем пустые строки
        try {
            const entry = JSON.parse(line);
            if (!entry.op || !entry.ts) { // Базовая проверка валидности записи
                console.warn(`WalManager: Пропущена неполная или поврежденная запись в WAL "${walPath}": ${line.substring(0,100)}...`);
                continue;
            }
            if (sinceTs && entry.ts < sinceTs) { // entry.ts должен быть ISO строкой для корректного сравнения
                continue; // Пропускаем старые записи, если указан sinceTs
            }
            operations.push(entry);
        } catch (parseError) {
            console.error(`WalManager: Ошибка парсинга JSON в записи WAL "${walPath}": "${line.substring(0, 100)}...". Запись пропущена. Ошибка: ${parseError.message}`);
            // Не бросаем ошибку, пытаемся восстановить как можно больше
        }
    }
    return operations;
}

/**
 * Обрабатывает WAL-файл после успешного выполнения чекпоинта.
 * Сохраняет записи, которые произошли во время или после метки времени чекпоинта.
 * @param {string} walPath - Полный путь к WAL-файлу.
 * @param {string} checkpointTs - Временная метка (ISO строка) начала чекпоинта.
 *                                Операции с ts >= checkpointTs будут сохранены.
 * @returns {Promise<void>}
 * @throws {Error} Если произошла критическая ошибка обработки WAL.
 */
async function processWalAfterCheckpoint(walPath, checkpointTs) {
    console.log(`WalManager: Обработка WAL "${walPath}" после чекпоинта (операции до ${checkpointTs} считаются вошедшими в чекпоинт).`);
    const MAX_RENAME_ATTEMPTS = 5; // Увеличим количество попыток
    const RENAME_DELAY_MS = 200;  // Увеличим задержку

    let originalWalExists = await pathExists(walPath);
    if (!originalWalExists) {
        console.log(`WalManager: WAL-файл "${walPath}" не существует. Обработка не требуется.`);
        return;
    }

    const tempWalPath = `${walPath}.${Date.now()}.${Math.random().toString(36).substring(2,7)}.tmp`; // Более уникальное имя

    try {
        const currentWalEntries = await readWal(walPath); // Читаем все операции из текущего WAL
        
        // Фильтруем записи, которые должны остаться в WAL (те, что новее или равны времени начала чекпоинта)
        const entriesToKeep = currentWalEntries.filter(entry => entry.ts >= checkpointTs);

        if (entriesToKeep.length > 0) {
            const newWalContent = entriesToKeep.map(entry => JSON.stringify(entry)).join('\n') + '\n';
            await fs.writeFile(tempWalPath, newWalContent, 'utf-8');
        } else {
            // Если нет записей для сохранения, создаем пустой временный файл.
            // Это обеспечит, что основной WAL-файл будет очищен при переименовании.
            await fs.writeFile(tempWalPath, '', 'utf-8');
        }

        // Пытаемся переименовать временный файл в основной с несколькими попытками
        let attempts = 0;
        while (attempts < MAX_RENAME_ATTEMPTS) {
            try {
                // Перед переименованием убедимся, что старый файл WAL все еще существует, если мы его не удаляли
                // Но так как мы пишем во временный, а потом переименовываем поверх старого, это не так важно.
                await fs.rename(tempWalPath, walPath);
                console.log(`WalManager: WAL "${walPath}" успешно ${entriesToKeep.length > 0 ? `обновлен, сохранено ${entriesToKeep.length} новых записей` : 'очищен'}.`);
                return; // Успех
            } catch (renameError) {
                attempts++;
                if ((renameError.code === 'EPERM' || renameError.code === 'EBUSY') && attempts < MAX_RENAME_ATTEMPTS) {
                    console.warn(`WalManager: Попытка ${attempts}/${MAX_RENAME_ATTEMPTS} переименования WAL "${tempWalPath}" -> "${walPath}" не удалась (${renameError.code}). Повтор через ${RENAME_DELAY_MS} мс.`);
                    await delay(RENAME_DELAY_MS);
                } else {
                    console.error(`WalManager: Не удалось переименовать временный WAL "${tempWalPath}" в "${walPath}" после ${attempts} попыток. Ошибка: ${renameError.message}`);
                    throw renameError; // Бросаем оригинальную ошибку переименования
                }
            }
        }
    } catch (error) {
        const errorMessage = `WalManager: Критическая ошибка обработки WAL "${walPath}" после чекпоинта: ${error.message}`;
        console.error(errorMessage, error.stack);
        // Важно: если здесь произошла ошибка, временный WAL мог остаться.
        // Попытаемся его удалить, чтобы не мешать следующей операции.
        if (await pathExists(tempWalPath)) {
            try {
                await fs.unlink(tempWalPath);
                console.log(`WalManager: Временный WAL "${tempWalPath}" удален после ошибки.`);
            } catch (unlinkError) {
                console.error(`WalManager: Не удалось удалить временный WAL "${tempWalPath}" после ошибки: ${unlinkError.message}`);
            }
        }
        throw new Error(errorMessage); // Перебрасываем агрегированную ошибку
    }
}

module.exports = {
    getWalPath,
    initializeWal,
    appendToWal,
    readWal,
    processWalAfterCheckpoint,
};