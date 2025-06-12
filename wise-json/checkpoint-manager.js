// wise-json/checkpoint-manager.js

const path = require('path');
const fs = require('fs/promises');
const { cleanupExpiredDocs } = require('./collection/ttl.js'); 
const logger = require('./logger'); 

/**
 * Возвращает все файлы чекпоинтов (meta или data) для указанной коллекции,
 * отсортированные по имени (что обычно означает по времени).
 * @param {string} checkpointsDir - Директория, где хранятся чекпоинты.
 * @param {string} collectionName - Имя коллекции.
 * @param {string} type - 'meta' или 'data'.
 * @returns {Promise<string[]>} - Массив имен файлов.
 */
async function getCheckpointFiles(checkpointsDir, collectionName, type = 'meta') {
    let files = [];
    try {
        try {
            await fs.access(checkpointsDir);
        } catch (accessError) {
            if (accessError.code === 'ENOENT') {
                // logger.debug(`[Checkpoint] Директория чекпоинтов ${checkpointsDir} не найдена при попытке получить файлы типа '${type}'. Возвращаем пустой список.`);
                return []; 
            }
            throw accessError; 
        }
        
        files = await fs.readdir(checkpointsDir);
    } catch (e) {
        if (e.code === 'ENOENT') {
            // logger.debug(`[Checkpoint] Ошибка ENOENT при чтении директории ${checkpointsDir} (возможно, была удалена конкурентно). Возвращаем пустой список.`);
            return [];
        }
        logger.error(`[Checkpoint] Ошибка чтения директории чекпоинтов ${checkpointsDir}: ${e.message}`);
        throw e; 
    }

    return files
        .filter(f => f.startsWith(`checkpoint_${type}_${collectionName}_`) && f.endsWith('.json'))
        .sort(); 
}

/**
 * Извлекает timestamp из имени meta-файла чекпоинта.
 * @param {string} metaFileName 
 * @param {string} collectionName 
 * @returns {string|null}
 */
function extractTimestampFromMetaFile(metaFileName, collectionName) {
    const re = new RegExp(`^checkpoint_meta_${collectionName}_(.+)\\.json$`);
    const match = metaFileName.match(re);
    return match ? match[1] : null;
}


/**
 * Загружает последний валидный чекпоинт (meta + все его data-сегменты) для коллекции.
 * Возвращает { documents: Map, indexesMeta, timestamp }
 */
async function loadLatestCheckpoint(checkpointsDir, collectionName) {
    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta');
    
    if (metaFiles.length === 0) {
        // ИЗМЕНЕНИЕ ЗДЕСЬ: logger.log вместо logger.info
        logger.log(`[Checkpoint] Файлы meta-чекпоинтов для коллекции '${collectionName}' не найдены. Это ожидаемо при первом запуске или если коллекция была очищена/удалена.`);
        return { documents: new Map(), indexesMeta: [], timestamp: null };
    }

    for (let i = metaFiles.length - 1; i >= 0; i--) {
        const currentMetaFile = metaFiles[i];
        const timestamp = extractTimestampFromMetaFile(currentMetaFile, collectionName);

        if (!timestamp) {
            logger.warn(`[Checkpoint] Не удалось извлечь timestamp из meta-файла '${currentMetaFile}' для коллекции '${collectionName}'. Файл будет пропущен.`);
            continue; 
        }

        const allDataFilesRaw = await getCheckpointFiles(checkpointsDir, collectionName, 'data');
        const dataSegmentFiles = allDataFilesRaw.filter(f => {
            const segMatch = f.match(new RegExp(`^checkpoint_data_${collectionName}_${timestamp}_seg\\d+\\.json$`));
            return !!segMatch;
        });

        if (dataSegmentFiles.length === 0 && metaFiles.length > 0) { 
            logger.warn(`[Checkpoint] Для meta-файла '${currentMetaFile}' (timestamp: ${timestamp}) коллекции '${collectionName}' не найдены соответствующие data-сегменты. Чекпоинт пропущен.`);
            continue;
        }
        
        dataSegmentFiles.sort();

        let metaContent;
        try {
            metaContent = JSON.parse(await fs.readFile(path.join(checkpointsDir, currentMetaFile), 'utf8'));
            if (metaContent.timestamp !== timestamp) {
                logger.warn(`[Checkpoint] Timestamp в содержимом meta-файла '${currentMetaFile}' ('${metaContent.timestamp}') не совпадает с timestamp из имени файла ('${timestamp}') для коллекции '${collectionName}'. Чекпоинт пропущен.`);
                continue;
            }
        } catch (e) {
            logger.warn(`[Checkpoint] ⚠ Ошибка чтения или парсинга meta-файла чекпоинта '${currentMetaFile}' для коллекции '${collectionName}': ${e.message}. Чекпоинт пропущен.`);
            continue; 
        }

        const documents = new Map();
        let allSegmentsLoadedSuccessfully = true;
        for (const segFile of dataSegmentFiles) {
            try {
                const segmentDocsArray = JSON.parse(await fs.readFile(path.join(checkpointsDir, segFile), 'utf8'));
                if (Array.isArray(segmentDocsArray)) {
                    for (const doc of segmentDocsArray) {
                        if (doc && typeof doc._id !== 'undefined') {
                            documents.set(doc._id, doc);
                        } else {
                            logger.warn(`[Checkpoint] Обнаружен документ без _id или некорректный документ в сегменте '${segFile}' (коллекция '${collectionName}'). Документ пропущен.`);
                        }
                    }
                } else {
                    logger.warn(`[Checkpoint] Data-сегмент '${segFile}' (коллекция '${collectionName}') не содержит массив. Сегмент пропущен.`);
                    allSegmentsLoadedSuccessfully = false; 
                    break; 
                }
            } catch (e) {
                logger.warn(`[Checkpoint] ⚠ Ошибка чтения или парсинга data-сегмента '${segFile}' (коллекция '${collectionName}'): ${e.message}. Сегмент пропущен.`);
                allSegmentsLoadedSuccessfully = false;
                break; 
            }
        }

        if (!allSegmentsLoadedSuccessfully) {
            logger.warn(`[Checkpoint] Не все data-сегменты для timestamp '${timestamp}' (коллекция '${collectionName}') были успешно загружены. Этот чекпоинт будет пропущен.`);
            continue; 
        }
        
        const removedByTtl = cleanupExpiredDocs(documents); 
        if (removedByTtl > 0) {
            logger.log(`[Checkpoint] [TTL] При загрузке чекпоинта для коллекции '${collectionName}' удалено ${removedByTtl} истекших документов.`);
        }

        return {
            documents,
            indexesMeta: metaContent.indexesMeta || [],
            timestamp: metaContent.timestamp 
        };
    }

    logger.warn(`[Checkpoint] Не удалось загрузить ни один валидный чекпоинт для коллекции '${collectionName}'. Коллекция будет инициализирована как пустая (или только из WAL).`);
    return { documents: new Map(), indexesMeta: [], timestamp: null };
}


/**
 * Удаляет старые чекпоинты, оставляя только последние N (по количеству meta-файлов).
 * @param {string} checkpointsDir 
 * @param {string} collectionName 
 * @param {number} keep 
 */
async function cleanupOldCheckpoints(checkpointsDir, collectionName, keep = 5) {
    if (keep <= 0) { 
        logger.warn(`[Checkpoint] cleanupOldCheckpoints вызван с keep <= 0 (${keep}) для коллекции '${collectionName}'. Очистка не будет выполнена.`);
        return;
    }

    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta');
    const allDataFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'data');

    const metaFilesToRemove = metaFiles.length > keep ? metaFiles.slice(0, metaFiles.length - keep) : [];
    
    const timestampsToKeep = new Set(
        metaFiles.slice(-keep).map(f => extractTimestampFromMetaFile(f, collectionName)).filter(Boolean)
    );

    for (const metaFileToRemove of metaFilesToRemove) {
        const filePath = path.join(checkpointsDir, metaFileToRemove);
        try {
            await fs.unlink(filePath);
        } catch (err) {
            if (err.code !== 'ENOENT') { 
                logger.warn(`[Checkpoint] Не удалось удалить meta-файл чекпоинта '${metaFileToRemove}' (коллекция: ${collectionName}): ${err.message}`);
            }
        }
    }

    const dataFilesToRemove = allDataFiles.filter(dataFile => {
        const match = dataFile.match(new RegExp(`^checkpoint_data_${collectionName}_(.+)_seg\\d+\\.json$`));
        const dataTimestamp = match ? match[1] : null;
        return dataTimestamp && !timestampsToKeep.has(dataTimestamp);
    });

    for (const dataFileToRemove of dataFilesToRemove) {
        const filePath = path.join(checkpointsDir, dataFileToRemove);
        try {
            await fs.unlink(filePath);
        } catch (err) {
            if (err.code !== 'ENOENT') { 
                logger.warn(`[Checkpoint] Не удалось удалить data-сегмент чекпоинта '${dataFileToRemove}' (коллекция: ${collectionName}): ${err.message}`);
            }
        }
    }
}

module.exports = {
    loadLatestCheckpoint,
    cleanupOldCheckpoints,
};