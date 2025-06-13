// wise-json/checkpoint-manager.js

const path = require('path');
const fs = require('fs/promises');
const { cleanupExpiredDocs } = require('./collection/ttl.js'); 
const logger = require('./logger'); 

async function getCheckpointFiles(checkpointsDir, collectionName, type = 'meta') {
    let files = [];
    try {
        try {
            await fs.access(checkpointsDir);
        } catch (accessError) {
            if (accessError.code === 'ENOENT') {
                return []; 
            }
            throw accessError; 
        }
        files = await fs.readdir(checkpointsDir);
    } catch (e) {
        if (e.code === 'ENOENT') {
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
 * Извлекает "безопасный для файла" timestamp (с дефисами) из имени meta-файла.
 * @param {string} metaFileName 
 * @param {string} collectionName 
 * @returns {string|null} - Timestamp YYYY-MM-DDTHH-mm-ss-SSSZ или null.
 */
function extractTimestampFromMetaFile(metaFileName, collectionName) {
    const re = new RegExp(`^checkpoint_meta_${collectionName}_([\\dTZ-]+)\\.json$`); 
    const match = metaFileName.match(re);
    return match ? match[1] : null;
}

async function loadLatestCheckpoint(checkpointsDir, collectionName) {
    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta');
    
    if (metaFiles.length === 0) {
        logger.log(`[Checkpoint] Файлы meta-чекпоинтов для коллекции '${collectionName}' не найдены. Это ожидаемо при первом запуске или если коллекция была очищена/удалена.`);
        return { documents: new Map(), indexesMeta: [], timestamp: null };
    }

    for (let i = metaFiles.length - 1; i >= 0; i--) {
        const currentMetaFile = metaFiles[i];
        const timestampFromFile = extractTimestampFromMetaFile(currentMetaFile, collectionName);

        if (!timestampFromFile) {
            logger.warn(`[Checkpoint] Не удалось извлечь файловый timestamp из meta-файла '${currentMetaFile}' для коллекции '${collectionName}'. Файл будет пропущен.`);
            continue; 
        }

        const allDataFilesRaw = await getCheckpointFiles(checkpointsDir, collectionName, 'data');
        const dataSegmentFiles = allDataFilesRaw.filter(f => {
            const segMatch = f.match(new RegExp(`^checkpoint_data_${collectionName}_${timestampFromFile}_seg\\d+\\.json$`));
            return !!segMatch;
        });

        // Если есть meta-файл, но для него нет data-сегментов (и это не пустой чекпоинт, который мог бы не иметь data-сегментов,
        // но такая логика не реализована явно, поэтому ожидаем data-сегменты, если meta есть)
        // Однако, пустая коллекция может создать meta, но 0 data-сегментов.
        // Поэтому эту проверку нужно делать аккуратнее.
        // Если metaContent.documentCount > 0, а dataSegmentFiles.length === 0, тогда это проблема.
        // Пока оставим как есть, но это место для возможного уточнения.

        let metaContent;
        try {
            metaContent = JSON.parse(await fs.readFile(path.join(checkpointsDir, currentMetaFile), 'utf8'));
            if (!metaContent.timestamp || typeof metaContent.timestamp !== 'string') {
                logger.warn(`[Checkpoint] Meta-файл '${currentMetaFile}' для коллекции '${collectionName}' не содержит валидного поля 'timestamp'. Чекпоинт пропущен.`);
                continue;
            }
            // Сравнение timestamp из имени файла (с дефисами) и из содержимого meta (ISO) не нужно,
            // если мы доверяем, что они соответствуют одному чекпоинту.
            // Главное - использовать правильный формат для Date.parse() далее.
            
        } catch (e) {
            logger.warn(`[Checkpoint] ⚠ Ошибка чтения или парсинга meta-файла чекпоинта '${currentMetaFile}' для коллекции '${collectionName}': ${e.message}. Чекпоинт пропущен.`);
            continue; 
        }
        
        // Если meta говорит, что документов 0, а data-сегментов нет - это валидный пустой чекпоинт.
        if (metaContent.documentCount === 0 && dataSegmentFiles.length === 0) {
            // logger.debug(`[Checkpoint] Загружен пустой чекпоинт для коллекции '${collectionName}' (ISO ts: ${metaContent.timestamp}).`);
            cleanupExpiredDocs(new Map()); // Вызов для консистентности, хотя Map пуст
             return {
                documents: new Map(),
                indexesMeta: metaContent.indexesMeta || [],
                timestamp: metaContent.timestamp 
            };
        }

        // Если meta говорит, что есть документы, но data-сегментов нет - это проблема.
        if (metaContent.documentCount > 0 && dataSegmentFiles.length === 0) {
            logger.warn(`[Checkpoint] Meta-файл '${currentMetaFile}' (ISO ts: ${metaContent.timestamp}) коллекции '${collectionName}' указывает на ${metaContent.documentCount} документов, но не найдены соответствующие data-сегменты. Чекпоинт пропущен.`);
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
            logger.warn(`[Checkpoint] Не все data-сегменты для файлового timestamp '${timestampFromFile}' (ISO ts: ${metaContent.timestamp}, коллекция '${collectionName}') были успешно загружены. Этот чекпоинт будет пропущен.`);
            continue; 
        }
        
        const removedByTtl = cleanupExpiredDocs(documents); 
        if (removedByTtl > 0) {
            logger.log(`[Checkpoint] [TTL] При загрузке чекпоинта для коллекции '${collectionName}' (ISO ts: ${metaContent.timestamp}) удалено ${removedByTtl} истекших документов.`);
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
        const match = dataFile.match(new RegExp(`^checkpoint_data_${collectionName}_([\\dTZ-]+)_seg\\d+\\.json$`)); 
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