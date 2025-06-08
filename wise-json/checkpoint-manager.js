const path = require('path');
const fs = require('fs/promises');
const { cleanupExpiredDocs } = require('./collection/ttl.js');

const logger = require('./logger');

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
 * Возвращает последний timestamp чекпоинта (общий для meta и data сегментов).
 * @param {string[]} metaFiles
 * @param {string[]} dataFiles
 * @returns {string|null}
 */
function getLastCheckpointTimestamp(metaFiles, dataFiles, collectionName) {
    // Берём последний meta файл
    if (!metaFiles.length || !dataFiles.length) return null;
    // Пример: checkpoint_meta_users_2025-06-07T08-21-10-654Z.json
    const lastMeta = metaFiles[metaFiles.length - 1];
    const re = new RegExp(`^checkpoint_meta_${collectionName}_(.+)\\.json$`);
    const match = lastMeta.match(re);
    return match ? match[1] : null;
}

/**
 * Загружает последний чекпоинт (meta + все data-сегменты) для коллекции.
 * Возвращает { documents: Map, indexesMeta, timestamp }
 */
async function loadLatestCheckpoint(checkpointsDir, collectionName) {
    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta');
    const dataFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'data');
    if (!metaFiles.length || !dataFiles.length) {
        return { documents: new Map(), indexesMeta: [], timestamp: null };
    }

    // Берём последний общий timestamp
    const timestamp = getLastCheckpointTimestamp(metaFiles, dataFiles, collectionName);
    if (!timestamp) {
        return { documents: new Map(), indexesMeta: [], timestamp: null };
    }

    // Файлы meta и data сегментов для этого timestamp
    const metaFile = `checkpoint_meta_${collectionName}_${timestamp}.json`;
    // Все data-сегменты:
    const dataSegmentFiles = dataFiles.filter(f =>
        f.startsWith(`checkpoint_data_${collectionName}_${timestamp}_seg`)
    );

    let meta, docsArr = [];

    // META
    try {
        meta = JSON.parse(await fs.readFile(path.join(checkpointsDir, metaFile), 'utf8'));
    } catch (e) {
        const fullPath = path.join(checkpointsDir, metaFile);
        try {
            await fs.access(fullPath);
            logger.warn(`[Checkpoint] ⚠ Ошибка чтения мета-чекпоинта (битый файл): ${fullPath}\n${e.stack || e.message}`);
        } catch {
            // Если файла нет — тишина
        }
        meta = { indexesMeta: [], timestamp: null };
    }

    // DATA: Склеиваем все сегменты!
    for (const segFile of dataSegmentFiles) {
        try {
            const arr = JSON.parse(await fs.readFile(path.join(checkpointsDir, segFile), 'utf8'));
            if (Array.isArray(arr)) docsArr.push(...arr);
        } catch (e) {
            const fullPath = path.join(checkpointsDir, segFile);
            try {
                await fs.access(fullPath);
                logger.warn(`[Checkpoint] ⚠ Ошибка чтения data-сегмента (битый файл): ${fullPath}\n${e.stack || e.message}`);
            } catch {
                // Если файла нет — тишина
            }
        }
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
    if (metaFile && dataSegmentFiles.length) {
        logger.log(`[Checkpoint] Загружен checkpoint: meta: ${metaFile}, data-сегментов: ${dataSegmentFiles.length} (docs: ${documents.size})`);
    } else {
        logger.warn(`[Checkpoint] Checkpoint files не найдены для коллекции: ${collectionName}`);
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
                logger.warn(`[Checkpoint] Не удалось удалить meta checkpoint: ${f} — ${e.stack || e.message}`);
            }
        }
    }
    // data-сегментов на каждый чекпоинт может быть много!
    if (dataFiles.length > keep * 2) {
        // Оставляем только те сегменты, чей timestamp среди последних keep чекпоинтов
        const keepTimestamps = new Set(
            metaFiles.slice(-keep).map(f => {
                const re = new RegExp(`^checkpoint_meta_${collectionName}_(.+)\\.json$`);
                const match = f.match(re);
                return match ? match[1] : null;
            }).filter(Boolean)
        );
        const toRemove = dataFiles.filter(f => {
            const m = f.match(new RegExp(`^checkpoint_data_${collectionName}_(.+)_seg\\d+\\.json$`));
            return !(m && keepTimestamps.has(m[1]));
        });
        for (const f of toRemove) {
            try {
                await fs.unlink(path.join(checkpointsDir, f));
            } catch (e) {
                logger.warn(`[Checkpoint] Не удалось удалить data checkpoint: ${f} — ${e.stack || e.message}`);
            }
        }
    }
}

module.exports = {
    loadLatestCheckpoint,
    cleanupOldCheckpoints
};
