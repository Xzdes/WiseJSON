// storage-utils.js
const fs = require('fs/promises');
const path = require('path');
const logger = require('./logger');

/**
 * Проверяет, существует ли указанный путь (файл или директория).
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (err) {
        if (err.code === 'ENOENT') return false;
        // ASSUMPTION: Для других ошибок (например, отказано в доступе) возвращаем false, но логируем.
        logger.warn(`[StorageUtils] Предупреждение: путь "${filePath}" не доступен (${err.code}).`);
        return false;
    }
}

/**
 * Создаёт директорию, если она не существует.
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
async function ensureDirectoryExists(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') {
            // ASSUMPTION: Ошибка создания директории критична, пробрасываем ошибку.
            logger.error(`[StorageUtils] Ошибка создания директории "${dirPath}": ${err.message}`);
            throw err;
        }
    }
}

/**
 * Безопасно записывает JSON в файл.
 * Пишет сначала во временный `.tmp` файл, затем переименовывает.
 * Это защищает от порчи данных при сбое.
 * @param {string} filePath - путь к финальному JSON-файлу
 * @param {any} data - данные для записи
 * @param {number|null} [jsonIndent=null] - отступ в JSON или null
 * @returns {Promise<void>}
 * @throws {Error} если запись или переименование не удались
 */
async function writeJsonFileSafe(filePath, data, jsonIndent = null) {
    const tmpName = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}.tmp`;
    const tmpPath = `${filePath}.${tmpName}`;

    try {
        const json = JSON.stringify(data, null, jsonIndent);
        await fs.writeFile(tmpPath, json, 'utf-8');
        try {
            await fs.rename(tmpPath, filePath);
        } catch (err) {
            // ASSUMPTION: Если переименование не удалось — пробуем удалить tmp-файл, бросаем ошибку выше.
            logger.error(`[StorageUtils] Ошибка переименования tmp-файла "${tmpPath}" -> "${filePath}": ${err.message}`);
            try {
                await fs.unlink(tmpPath);
            } catch (unlinkErr) {
                // Если не смогли удалить tmp-файл — только логируем, не бросаем ошибку повторно.
                logger.warn(`[StorageUtils] Не удалось удалить tmp-файл после сбоя rename "${tmpPath}": ${unlinkErr.message}`);
            }
            throw err;
        }
    } catch (err) {
        // ASSUMPTION: Любая ошибка на любом этапе считается критичной, пробрасываем наружу.
        logger.error(`[StorageUtils] Ошибка записи JSON в "${filePath}": ${err.message}`);
        if (await pathExists(tmpPath)) {
            try {
                await fs.unlink(tmpPath);
            } catch (unlinkErr) {
                logger.warn(`[StorageUtils] Не удалось удалить tmp-файл "${tmpPath}": ${unlinkErr.message}`);
            }
        }
        throw err;
    }
}

/**
 * Читает JSON-файл с диска и парсит его.
 * @param {string} filePath
 * @returns {Promise<any|null>}
 * @throws {Error} если файл есть, но повреждён (некорректный JSON)
 */
async function readJsonFile(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        try {
            return JSON.parse(raw);
        } catch (parseErr) {
            // ASSUMPTION: Повреждённый JSON-файл — это критическая ошибка.
            logger.error(`[StorageUtils] Ошибка парсинга JSON-файла "${filePath}": ${parseErr.message}`);
            throw parseErr;
        }
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        // ASSUMPTION: Ошибки чтения кроме ENOENT критичны, пробрасываем дальше.
        logger.error(`[StorageUtils] Ошибка чтения JSON-файла "${filePath}": ${err.message}`);
        throw err;
    }
}

/**
 * Копирует файл (например, для создания резервной копии).
 * Если dst уже существует — перезаписывает.
 * @param {string} src
 * @param {string} dst
 * @returns {Promise<void>}
 * @throws {Error} если копирование не удалось
 */
async function copyFileSafe(src, dst) {
    try {
        await fs.copyFile(src, dst);
    } catch (err) {
        // ASSUMPTION: Ошибка копирования критична, пробрасываем наружу.
        logger.error(`[StorageUtils] Ошибка копирования из "${src}" в "${dst}": ${err.message}`);
        throw err;
    }
}

/**
 * Удаляет файл, если он существует.
 * @param {string} filePath
 * @returns {Promise<void>}
 * @remarks Логирует, но не бросает ошибку, если удаление не удалось.
 */
async function deleteFileIfExists(filePath) {
    try {
        if (await pathExists(filePath)) {
            try {
                await fs.unlink(filePath);
            } catch (err) {
                // ASSUMPTION: Неудачное удаление файла не критично для работы системы, только логируем.
                logger.warn(`[StorageUtils] Не удалось удалить файл "${filePath}": ${err.message}`);
            }
        }
    } catch (err) {
        // ASSUMPTION: Ошибка при проверке существования файла не критична, только логируем.
        logger.warn(`[StorageUtils] Не удалось проверить наличие файла "${filePath}": ${err.message}`);
    }
}

module.exports = {
    pathExists,
    ensureDirectoryExists,
    writeJsonFileSafe,
    readJsonFile,
    copyFileSafe,
    deleteFileIfExists,
};
