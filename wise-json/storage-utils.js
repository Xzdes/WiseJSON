// wise-json/storage-utils.js
const fs = require('fs/promises');
const path = require('path');

/**
 * Гарантирует существование директории. Если она не существует, создает ее.
 * @param {string} dirPath - Путь к директории.
 * @returns {Promise<void>}
 * @throws {Error} Если не удалось создать директорию.
 */
async function ensureDirectoryExists(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            const errorMessage = `StorageUtils: Не удалось создать или проверить директорию "${dirPath}": ${error.message}`;
            console.error(errorMessage, error.stack);
            throw new Error(errorMessage);
        }
    }
}

/**
 * Проверяет, существует ли путь (файл или директория).
 * @param {string} filePath - Путь к файлу или директории.
 * @returns {Promise<boolean>} true, если путь существует, иначе false.
 */
async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Безопасно записывает данные в JSON-файл, используя временный файл и переименование.
 * @param {string} filePath - Конечный путь к файлу.
 * @param {any} data - Данные для сериализации в JSON и записи.
 * @param {number|null} [jsonIndent=null] - Отступ для JSON.stringify. null для компактного вывода.
 * @returns {Promise<void>}
 * @throws {Error} Если произошла ошибка записи.
 */
async function writeJsonFileSafe(filePath, data, jsonIndent = null) {
    const tempFilePath = `${filePath}.${Date.now()}.tmp`;
    try {
        const jsonData = JSON.stringify(data, null, jsonIndent);
        await fs.writeFile(tempFilePath, jsonData, 'utf-8');
        await fs.rename(tempFilePath, filePath);
    } catch (error) {
        if (await pathExists(tempFilePath)) {
            try {
                await fs.unlink(tempFilePath);
            } catch (unlinkError) {
                console.error(`StorageUtils: Не удалось удалить временный файл "${tempFilePath}" после ошибки записи в "${filePath}": ${unlinkError.message}`);
            }
        }
        const errorMessage = `StorageUtils: Ошибка безопасной записи JSON в файл "${filePath}": ${error.message}`;
        console.error(errorMessage, error.stack);
        throw new Error(errorMessage);
    }
}

/**
 * Читает и парсит JSON-файл.
 * @param {string} filePath - Путь к JSON-файлу.
 * @returns {Promise<any|null>} Распарсенные данные или null, если файл не найден.
 * @throws {Error} Если файл существует, но поврежден или не является валидным JSON.
 */
async function readJsonFile(filePath) {
    try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        const errorMessage = `StorageUtils: Ошибка чтения или парсинга JSON-файла "${filePath}": ${error.message}`;
        console.error(errorMessage, error.stack);
        throw new Error(errorMessage);
    }
}

module.exports = {
    ensureDirectoryExists,
    pathExists,
    writeJsonFileSafe,
    readJsonFile,
};