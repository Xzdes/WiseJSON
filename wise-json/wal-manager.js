const fs = require('fs/promises');
const path = require('path');

/**
 * Возвращает путь к WAL-файлу коллекции.
 * @param {string} collectionDirPath
 * @param {string} collectionName
 */
function getWalPath(collectionDirPath, collectionName) {
    return path.join(collectionDirPath, `${collectionName}.wal`);
}

/**
 * Инициализация WAL: если файла нет — создаёт пустой WAL.
 */
async function initializeWal(walPath, collectionDirPath) {
    try {
        await fs.mkdir(collectionDirPath, { recursive: true });
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
 * Чтение WAL-файла, возвращает массив операций начиная с указанного timestamp (если есть).
 * Поддержка batch (BATCH_INSERT).
 * Если sinceTimestamp не задан — возвращает все.
 */
async function readWal(walPath, sinceTimestamp = null) {
    let raw;
    try {
        raw = await fs.readFile(walPath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
    const lines = raw.trim().split('\n');
    const result = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            // Реализация фильтрации по времени:
            if (sinceTimestamp && entry.timestamp) {
                if (entry.timestamp > sinceTimestamp) {
                    result.push(entry);
                }
            } else if (!sinceTimestamp) {
                result.push(entry);
            }
            // Если нет timestamp — опционально можно всегда добавлять, если sinceTimestamp не указан
        } catch (e) {}
    }
    return result;
}

module.exports = {
    getWalPath,
    initializeWal,
    readWal
};
