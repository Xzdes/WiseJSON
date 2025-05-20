// storage-utils.js
const fs = require('fs/promises');
const path = require('path');

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
        console.warn(`[StorageUtils] Предупреждение: путь "${filePath}" не доступен (${err.code}).`);
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
            console.error(`[StorageUtils] Ошибка создания директории "${dirPath}": ${err.message}`);
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
 */
async function writeJsonFileSafe(filePath, data, jsonIndent = null) {
    const tmpName = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}.tmp`;
    const tmpPath = `${filePath}.${tmpName}`;

    try {
        const json = JSON.stringify(data, null, jsonIndent);
        await fs.writeFile(tmpPath, json, 'utf-8');
        await fs.rename(tmpPath, filePath);
    } catch (err) {
        console.error(`[StorageUtils] Ошибка записи JSON в "${filePath}": ${err.message}`);
        if (await pathExists(tmpPath)) {
            try {
                await fs.unlink(tmpPath);
            } catch (unlinkErr) {
                console.warn(`[StorageUtils] Не удалось удалить tmp-файл "${tmpPath}": ${unlinkErr.message}`);
            }
        }
        throw err;
    }
}

/**
 * Читает JSON-файл с диска и парсит его.
 * @param {string} filePath
 * @returns {Promise<any|null>}
 */
async function readJsonFile(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.error(`[StorageUtils] Ошибка чтения JSON-файла "${filePath}": ${err.message}`);
        throw err;
    }
}

/**
 * Копирует файл (например, для создания резервной копии).
 * Если dst уже существует — перезаписывает.
 * @param {string} src
 * @param {string} dst
 * @returns {Promise<void>}
 */
async function copyFileSafe(src, dst) {
    try {
        await fs.copyFile(src, dst);
    } catch (err) {
        console.error(`[StorageUtils] Ошибка копирования из "${src}" в "${dst}": ${err.message}`);
        throw err;
    }
}

/**
 * Удаляет файл, если он существует.
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function deleteFileIfExists(filePath) {
    try {
        if (await pathExists(filePath)) {
            await fs.unlink(filePath);
        }
    } catch (err) {
        console.warn(`[StorageUtils] Не удалось удалить файл "${filePath}": ${err.message}`);
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
