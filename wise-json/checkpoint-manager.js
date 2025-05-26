const path = require('path');
const fs = require('fs/promises');
const { cleanupExpiredDocs } = require('./collection/ttl.js');

/**
 * Возвращает все файлы в папке чекпоинтов для коллекции.
 */
async function getCheckpointFiles(checkpointsDir, collectionName, type = 'meta') {
    let files = [];
    try {
        files = await fs.readdir(checkpointsDir);
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
    return files
        .filter(f => f.startsWith(`checkpoint_${type}_${collectionName}_`))
        .sort(); // по дате (имя содержит timestamp)
}

/**
 * Загружает последний чекпоинт (meta + data) для коллекции.
 * Возвращает { documents: Map, indexesMeta, timestamp }
 */
async function loadLatestCheckpoint(checkpointsDir, collectionName) {
    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta');
    const dataFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'data');
    if (!metaFiles.length || !dataFiles.length) {
        return { documents: new Map(), indexesMeta: [], timestamp: null };
    }

    // Берём последний (он самый свежий)
    const metaFile = metaFiles[metaFiles.length - 1];
    const dataFile = dataFiles[dataFiles.length - 1];

    let meta, docsArr;

    // META
    try {
        meta = JSON.parse(await fs.readFile(path.join(checkpointsDir, metaFile), 'utf8'));
    } catch (e) {
        // Если файл есть, но не читается (битый) — предупреждение!
        const fullPath = path.join(checkpointsDir, metaFile);
        try {
            await fs.access(fullPath);
            console.warn(`[Checkpoint] ⚠ Ошибка чтения мета-чекпоинта (битый файл): ${fullPath}\n${e.stack || e.message}`);
        } catch {
            // Если файла нет — тишина
        }
        meta = { indexesMeta: [], timestamp: null };
    }

    // DATA
    try {
        docsArr = JSON.parse(await fs.readFile(path.join(checkpointsDir, dataFile), 'utf8'));
    } catch (e) {
        const fullPath = path.join(checkpointsDir, dataFile);
        try {
            await fs.access(fullPath);
            console.warn(`[Checkpoint] ⚠ Ошибка чтения data-чекпоинта (битый файл): ${fullPath}\n${e.stack || e.message}`);
        } catch {
            // Если файла нет — тишина
        }
        docsArr = [];
    }

    // Восстанавливаем batch'ами (вся коллекция в одном массиве)
    const documents = new Map();
    for (const doc of docsArr) {
        if (doc && typeof doc._id !== 'undefined') {
            documents.set(doc._id, doc);
        }
    }

    // Чистим expired документы (TTL)
    cleanupExpiredDocs(documents);

    // Явное логгирование для дебага
    if (metaFile && dataFile) {
        console.log(`[Checkpoint] Загружен checkpoint: meta: ${metaFile}, data: ${dataFile} (docs: ${documents.size})`);
    } else {
        console.warn(`[Checkpoint] Checkpoint files не найдены для коллекции: ${collectionName}`);
    }

    return {
        documents,
        indexesMeta: meta.indexesMeta || [],
        timestamp: meta.timestamp || null
    };
}

/**
 * Удаляет старые чекпоинты, оставляя только последние N (например, 5)
 */
async function cleanupOldCheckpoints(checkpointsDir, collectionName, keep = 5) {
    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta');
    const dataFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'data');
    if (metaFiles.length > keep) {
        const toRemove = metaFiles.slice(0, metaFiles.length - keep);
        for (const f of toRemove) {
            try {
                await fs.unlink(path.join(checkpointsDir, f));
            } catch (e) {
                console.warn(`[Checkpoint] Не удалось удалить meta checkpoint: ${f} — ${e.stack || e.message}`);
            }
        }
    }
    if (dataFiles.length > keep) {
        const toRemove = dataFiles.slice(0, dataFiles.length - keep);
        for (const f of toRemove) {
            try {
                await fs.unlink(path.join(checkpointsDir, f));
            } catch (e) {
                console.warn(`[Checkpoint] Не удалось удалить data checkpoint: ${f} — ${e.stack || e.message}`);
            }
        }
    }
}

module.exports = {
    loadLatestCheckpoint,
    cleanupOldCheckpoints
};
