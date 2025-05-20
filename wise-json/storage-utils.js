// wise-json/storage-utils.js
const fs = require('fs/promises');
const path = require('path'); // path не используется в текущих функциях, но может понадобиться для будущих утилит

/**
 * Гарантирует существование директории. Если она не существует, создает ее.
 * Включает опцию `recursive: true` для создания вложенных директорий.
 * @param {string} dirPath - Путь к директории.
 * @returns {Promise<void>}
 * @throws {Error} Если не удалось создать директорию (кроме случая, когда она уже существует).
 */
async function ensureDirectoryExists(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        // fs.mkdir с recursive: true не бросает ошибку, если директория уже существует (EEXIST).
        // Поэтому ловим только другие возможные ошибки.
        if (error.code !== 'EEXIST') {
            const errorMessage = `StorageUtils: Не удалось создать или проверить директорию "${dirPath}": ${error.message}`;
            console.error(errorMessage, error.stack);
            throw new Error(errorMessage); // Перебрасываем для обработки выше
        }
        // Если EEXIST, то все в порядке, директория существует.
    }
}

/**
 * Проверяет, существует ли путь (файл или директория) в файловой системе.
 * @param {string} filePath - Путь к файлу или директории.
 * @returns {Promise<boolean>} true, если путь существует, иначе false.
 */
async function pathExists(filePath) {
    try {
        await fs.access(filePath); // Проверяет доступность файла/директории
        return true;
    } catch (error) {
        // Если fs.access бросает ошибку (обычно ENOENT), значит путь не существует или недоступен
        if (error.code === 'ENOENT') {
            return false;
        }
        // Для других ошибок доступа (например, EACCES), мы также считаем, что путь "не существует"
        // с точки зрения возможности работы с ним, или можно перебросить ошибку, если нужна гранулярность.
        // Пока что для простоты возвращаем false.
        console.warn(`StorageUtils: Ошибка доступа к пути "${filePath}" (код: ${error.code}), считаем, что путь не существует.`);
        return false;
    }
}

/**
 * Безопасно записывает данные в JSON-файл.
 * Сначала данные записываются во временный файл, а затем временный файл
 * атомарно (на большинстве файловых систем) переименовывается в основной.
 * Это предотвращает повреждение основного файла в случае сбоя во время записи.
 * @param {string} filePath - Конечный путь к JSON-файлу.
 * @param {any} data - Данные для сериализации в JSON и записи.
 * @param {number|null} [jsonIndent=null] - Отступ для функции JSON.stringify.
 *                                          Передайте `null` или `0` для компактного вывода без отступов.
 * @returns {Promise<void>}
 * @throws {Error} Если произошла ошибка на любом этапе записи или переименования.
 */
async function writeJsonFileSafe(filePath, data, jsonIndent = null) {
    // Генерируем уникальное имя для временного файла в той же директории
    const tempFilePath = `${filePath}.${Date.now()}-${Math.random().toString(36).substring(2, 9)}.tmp`;
    
    try {
        const jsonData = JSON.stringify(data, null, jsonIndent);
        await fs.writeFile(tempFilePath, jsonData, 'utf-8');
        await fs.rename(tempFilePath, filePath); // Атомарное переименование
    } catch (error) {
        // Если произошла ошибка, пытаемся удалить временный файл, если он был создан
        if (await pathExists(tempFilePath)) {
            try {
                await fs.unlink(tempFilePath);
            } catch (unlinkError) {
                // Логируем ошибку удаления временного файла, но не маскируем основную ошибку
                console.error(`StorageUtils: Не удалось удалить временный файл "${tempFilePath}" после ошибки записи в "${filePath}": ${unlinkError.message}`);
            }
        }
        const errorMessage = `StorageUtils: Ошибка безопасной записи JSON в файл "${filePath}": ${error.message}`;
        console.error(errorMessage, error.stack);
        throw new Error(errorMessage); // Перебрасываем основную ошибку
    }
}

/**
 * Читает и парсит JSON-файл.
 * @param {string} filePath - Путь к JSON-файлу.
 * @returns {Promise<any|null>} Распарсенные данные (объект или массив) или `null`, если файл не найден.
 * @throws {Error} Если файл существует, но содержит невалидный JSON или произошла другая ошибка чтения (кроме ENOENT).
 */
async function readJsonFile(filePath) {
    try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null; // Файл не найден - это ожидаемый сценарий, возвращаем null
        }
        // Для других ошибок (например, SyntaxError при JSON.parse или EACCES при readFile)
        const errorMessage = `StorageUtils: Ошибка чтения или парсинга JSON-файла "${filePath}": ${error.message}`;
        console.error(errorMessage, error.stack);
        throw new Error(errorMessage); // Перебрасываем ошибку
    }
}

// Экспортируем функции для использования в других модулях
module.exports = {
    ensureDirectoryExists,
    pathExists,
    writeJsonFileSafe,
    readJsonFile,
};