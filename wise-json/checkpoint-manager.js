// wise-json/checkpoint-manager.js

const path = require('path');
const fs = require('fs/promises');
const { cleanupExpiredDocs } = require('./collection/ttl.js'); 
// const logger = require('./logger'); // --- УДАЛЕНО

// +++ ИЗМЕНЕНИЕ: Добавлен параметр `logger` +++
async function getCheckpointFiles(checkpointsDir, collectionName, type = 'meta', logger) {
    const log = logger || require('./logger');
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
        log.error(`[Checkpoint] Ошибка чтения директории чекпоинтов ${checkpointsDir}: ${e.message}`);
        throw e; 
    }
    return files
        .filter(f => f.startsWith(`checkpoint_${type}_${collectionName}_`) && f.endsWith('.json'))
        .sort(); 
}

function extractTimestampFromMetaFile(metaFileName, collectionName) {
    const re = new RegExp(`^checkpoint_meta_${collectionName}_([\\dTZ-]+)\\.json$`); 
    const match = metaFileName.match(re);
    return match ? match[1] : null;
}

// +++ ИЗМЕНЕНИЕ: Добавлен параметр `logger` +++
async function loadLatestCheckpoint(checkpointsDir, collectionName, logger) {
    const log = logger || require('./logger');
    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta', log);
    
    if (metaFiles.length === 0) {
        log.log(`[Checkpoint] Файлы meta-чекпоинтов для коллекции '${collectionName}' не найдены. Это ожидаемо при первом запуске или если коллекция была очищена/удалена.`);
        return { documents: new Map(), indexesMeta: [], timestamp: null };
    }

    for (let i = metaFiles.length - 1; i >= 0; i--) {
        const currentMetaFile = metaFiles[i];
        const timestampFromFile = extractTimestampFromMetaFile(currentMetaFile, collectionName);

        if (!timestampFromFile) {
            log.warn(`[Checkpoint] Не удалось извлечь файловый timestamp из meta-файла '${currentMetaFile}' для коллекции '${collectionName}'. Файл будет пропущен.`);
            continue; 
        }

        const allDataFilesRaw = await getCheckpointFiles(checkpointsDir, collectionName, 'data', log);
        const dataSegmentFiles = allDataFilesRaw.filter(f => {
            const segMatch = f.match(new RegExp(`^checkpoint_data_${collectionName}_${timestampFromFile}_seg\\d+\\.json$`));
            return !!segMatch;
        });
        dataSegmentFiles.sort();

        let metaContent;
        try {
            metaContent = JSON.parse(await fs.readFile(path.join(checkpointsDir, currentMetaFile), 'utf8'));
            if (!metaContent.timestamp || typeof metaContent.timestamp !== 'string') {
                log.warn(`[Checkpoint] Meta-файл '${currentMetaFile}' для коллекции '${collectionName}' не содержит валидного поля 'timestamp'. Чекпоинт пропущен.`);
                continue;
            }
        } catch (e) {
            log.warn(`[Checkpoint] ⚠ Ошибка чтения или парсинга meta-файла чекпоинта '${currentMetaFile}' для коллекции '${collectionName}': ${e.message}. Чекпоинт пропущен.`);
            continue; 
        }
        
        if (metaContent.documentCount === 0 && dataSegmentFiles.length === 0) {
            cleanupExpiredDocs(new Map());
             return {
                documents: new Map(),
                indexesMeta: metaContent.indexesMeta || [],
                timestamp: metaContent.timestamp 
            };
        }

        if (metaContent.documentCount > 0 && dataSegmentFiles.length === 0) {
            log.warn(`[Checkpoint] Meta-файл '${currentMetaFile}' (ISO ts: ${metaContent.timestamp}) коллекции '${collectionName}' указывает на ${metaContent.documentCount} документов, но не найдены соответствующие data-сегменты. Чекпоинт пропущен.`);
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
                            log.warn(`[Checkpoint] Обнаружен документ без _id или некорректный документ в сегменте '${segFile}' (коллекция '${collectionName}'). Документ пропущен.`);
                        }
                    }
                } else {
                    log.warn(`[Checkpoint] Data-сегмент '${segFile}' (коллекция '${collectionName}') не содержит массив. Сегмент пропущен.`);
                    allSegmentsLoadedSuccessfully = false; 
                    break; 
                }
            } catch (e) {
                log.warn(`[Checkpoint] ⚠ Ошибка чтения или парсинга data-сегмента '${segFile}' (коллекция '${collectionName}'): ${e.message}. Сегмент пропущен.`);
                allSegmentsLoadedSuccessfully = false;
                break; 
            }
        }

        if (!allSegmentsLoadedSuccessfully) {
            log.warn(`[Checkpoint] Не все data-сегменты для файлового timestamp '${timestampFromFile}' (ISO ts: ${metaContent.timestamp}, коллекция '${collectionName}') были успешно загружены. Этот чекпоинт будет пропущен.`);
            continue; 
        }
        
        const removedByTtl = cleanupExpiredDocs(documents); 
        if (removedByTtl > 0) {
            log.log(`[Checkpoint] [TTL] При загрузке чекпоинта для коллекции '${collectionName}' (ISO ts: ${metaContent.timestamp}) удалено ${removedByTtl} истекших документов.`);
        }

        return {
            documents,
            indexesMeta: metaContent.indexesMeta || [],
            timestamp: metaContent.timestamp 
        };
    }

    log.warn(`[Checkpoint] Не удалось загрузить ни один валидный чекпоинт для коллекции '${collectionName}'. Коллекция будет инициализирована как пустая (или только из WAL).`);
    return { documents: new Map(), indexesMeta: [], timestamp: null };
}

// +++ ИЗМЕНЕНИЕ: Добавлен параметр `logger` +++
async function cleanupOldCheckpoints(checkpointsDir, collectionName, keep = 5, logger) {
    const log = logger || require('./logger');
    if (keep <= 0) { 
        log.warn(`[Checkpoint] cleanupOldCheckpoints вызван с keep <= 0 (${keep}) для коллекции '${collectionName}'. Очистка не будет выполнена.`);
        return;
    }

    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta', log);
    const allDataFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'data', log);

    const metaFilesToRemove = metaFiles.length > keep ? metaFiles.slice(0, metaFiles.length - keep) : [];
    
    const timestampsToKeep = new Set(
        metaFiles.slice(-keep).map(f => extractTimestampFromMetaFile(f, collectionName)).filter(Boolean)
    );

    const unlinkWithRetry = async (filePath, fileNameForLog) => {
        let retries = 10;
        let currentDelay = 500;

        while (retries > 0) {
            try {
                await fs.unlink(filePath);
                return true; 
            } catch (err) {
                if (err.code === 'ENOENT') {
                    return true; 
                }
                retries--;
                if (retries === 0) {
                    log.warn(`[Checkpoint] Не удалось удалить файл '${fileNameForLog}' (коллекция: ${collectionName}) после нескольких попыток: ${err.code} - ${err.message}`);
                    return false; 
                }
                await new Promise(resolve => setTimeout(resolve, currentDelay));
                currentDelay = Math.min(currentDelay + 500, 3000);
            }
        }
        return false;
    };

    for (const metaFileToRemove of metaFilesToRemove) {
        const filePath = path.join(checkpointsDir, metaFileToRemove);
        await unlinkWithRetry(filePath, metaFileToRemove);
    }

    const dataFilesToRemove = allDataFiles.filter(dataFile => {
        const match = dataFile.match(new RegExp(`^checkpoint_data_${collectionName}_([\\dTZ-]+)_seg\\d+\\.json$`)); 
        const dataTimestamp = match ? match[1] : null;
        return dataTimestamp && !timestampsToKeep.has(dataTimestamp);
    });

    for (const dataFileToRemove of dataFilesToRemove) {
        const filePath = path.join(checkpointsDir, dataFileToRemove);
        await unlinkWithRetry(filePath, dataFileToRemove);
    }
}

module.exports = {
    loadLatestCheckpoint,
    cleanupOldCheckpoints,
};