// wise-json/checkpoint-manager.js
const fs = require('fs/promises');
const path = require('path');
const { ensureDirectoryExists, writeJsonFileSafe, readJsonFile, pathExists } = require('./storage-utils.js');

const CHECKPOINT_DIR_NAME = '_checkpoints';
const CHECKPOINT_META_FILE_PREFIX = 'checkpoint_meta_';
const CHECKPOINT_DATA_FILE_PREFIX = 'checkpoint_data_';
const TEMP_CHECKPOINT_META_SUFFIX = '.tmp_meta'; 
// TEMP_CHECKPOINT_DATA_SUFFIX не используется, т.к. writeJsonFileSafe сама создает .tmp для каждого сегмента.

function getCheckpointsPath(collectionDirPath) {
    return path.join(collectionDirPath, CHECKPOINT_DIR_NAME);
}

/**
 * Выполняет чекпоинт: сохраняет текущее состояние документов и метаданные индексов на диск.
 * @param {string} checkpointsDirPath - Путь к директории, где хранятся чекпоинты.
 * @param {string} collectionName - Имя коллекции (для именования файлов).
 * @param {Map<string, object>} documents - Данные коллекции (Map документов).
 * @param {string} checkpointTs - Временная метка текущего чекпоинта (ISO строка).
 * @param {object} options - Опции коллекции (jsonIndent, maxSegmentSizeBytes).
 * @param {Array<object>} [indexMetadataToSave=[]] - Массив метаданных об активных индексах
 *                                            (например, [{fieldName: 'email', type: 'unique'}, ...]).
 * @returns {Promise<{timestamp: string, files: string[], totalDocuments: number, metaFile: string, indexesMeta?: Array<object>}>}
 *          Метаданные сохраненного чекпоинта.
 * @throws {Error} Если произошла ошибка при создании чекпоинта.
 */
async function performCheckpoint(checkpointsDirPath, collectionName, documents, checkpointTs, options, indexMetadataToSave = []) {
    await ensureDirectoryExists(checkpointsDirPath);

    const jsonDataIndent = options.jsonIndent !== undefined ? options.jsonIndent : null;
    const maxSegmentSizeBytes = options.maxSegmentSizeBytes && options.maxSegmentSizeBytes > 0 
        ? options.maxSegmentSizeBytes 
        : (1 * 1024 * 1024); 

    const finalDataFileNames = []; 
    const tempSegmentFilePaths = [];   // Используется для отката, если сегменты пишутся с .tmp_data суффиксом
    const finalSegmentFilePaths = [];  // Используется для отката, если сегменты пишутся сразу с финальным именем

    const docsArray = Array.from(documents.values());
    let currentSegmentDocs = [];
    let currentSegmentJsonLength = 2; 

    const sanitizedTs = checkpointTs.replace(/[:.]/g, '-');
    const finalMetaFileName = `${CHECKPOINT_META_FILE_PREFIX}${collectionName}_${sanitizedTs}.json`;
    const tempMetaFilePath = path.join(checkpointsDirPath, `${finalMetaFileName}${TEMP_CHECKPOINT_META_SUFFIX}`);
    const finalMetaFilePath = path.join(checkpointsDirPath, finalMetaFileName);
    
    // Список созданных файлов для возможного отката
    const createdFilesForRollback = [];

    try {
        // 1. Записываем все сегменты данных
        for (let i = 0; i < docsArray.length; i++) {
            const doc = docsArray[i];
            const docJsonString = JSON.stringify(doc); 
            const docByteLength = Buffer.byteLength(docJsonString, 'utf8');
            const estimatedAddedLength = docByteLength + (currentSegmentDocs.length > 0 ? 1 : 0);

            if (currentSegmentJsonLength + estimatedAddedLength > maxSegmentSizeBytes && currentSegmentDocs.length > 0) {
                const segmentBaseName = `${CHECKPOINT_DATA_FILE_PREFIX}${collectionName}_${sanitizedTs}_seg${finalDataFileNames.length}.json`;
                const segmentFilePath = path.join(checkpointsDirPath, segmentBaseName);
                await writeJsonFileSafe(segmentFilePath, currentSegmentDocs, jsonDataIndent);
                
                finalDataFileNames.push(segmentBaseName);
                createdFilesForRollback.push(segmentFilePath); // Добавляем финальное имя, т.к. writeJsonFileSafe атомарна для одного файла
                
                currentSegmentDocs = []; 
                currentSegmentJsonLength = 2;
            }
            currentSegmentDocs.push(doc);
            currentSegmentJsonLength += estimatedAddedLength;
        }

        if (currentSegmentDocs.length > 0) {
            const segmentBaseName = `${CHECKPOINT_DATA_FILE_PREFIX}${collectionName}_${sanitizedTs}_seg${finalDataFileNames.length}.json`;
            const segmentFilePath = path.join(checkpointsDirPath, segmentBaseName);
            await writeJsonFileSafe(segmentFilePath, currentSegmentDocs, jsonDataIndent);
            finalDataFileNames.push(segmentBaseName);
            createdFilesForRollback.push(segmentFilePath);
        } else if (docsArray.length === 0 && finalDataFileNames.length === 0) { 
            const segmentBaseName = `${CHECKPOINT_DATA_FILE_PREFIX}${collectionName}_${sanitizedTs}_seg0.json`;
            const segmentFilePath = path.join(checkpointsDirPath, segmentBaseName);
            await writeJsonFileSafe(segmentFilePath, [], jsonDataIndent); 
            finalDataFileNames.push(segmentBaseName);
            createdFilesForRollback.push(segmentFilePath);
        }

        // 2. Все сегменты данных успешно записаны. Создаем мета-файл.
        const checkpointMeta = {
            timestamp: checkpointTs, 
            collectionName: collectionName,
            segmentFiles: finalDataFileNames, 
            totalDocuments: docsArray.length,
            indexes: indexMetadataToSave || [] // Сохраняем метаданные индексов
        };
        
        await writeJsonFileSafe(tempMetaFilePath, checkpointMeta, jsonDataIndent);
        createdFilesForRollback.push(tempMetaFilePath); // Временный мета-файл тоже может потребовать удаления при откате

        // 3. Атомарно "публикуем" чекпоинт, переименовывая временный мета-файл в основной.
        // Файлы сегментов уже имеют финальные имена, так как writeJsonFileSafe для них атомарна.
        await fs.rename(tempMetaFilePath, finalMetaFilePath);
        // После успешного rename, tempMetaFilePath больше не существует в списке для отката.
        createdFilesForRollback.pop(); // Удаляем tempMetaFilePath из списка отката
        createdFilesForRollback.push(finalMetaFilePath); // Добавляем финальный метафайл, на случай если последующие операции упадут (хотя их нет)
        
        console.log(`CheckpointManager: Чекпоинт для "${collectionName}" (ts: ${checkpointTs}) успешно создан и опубликован. Мета: ${finalMetaFileName}. Сегменты: ${finalDataFileNames.length}. Индексов: ${checkpointMeta.indexes.length}`);
        return { ...checkpointMeta, metaFile: finalMetaFileName };

    } catch (error) {
        console.error(`CheckpointManager: Ошибка при создании чекпоинта (ts: ${checkpointTs}) для "${collectionName}": ${error.message}. Попытка отката созданных файлов...`);
        for (const fp of createdFilesForRollback) { 
            try {
                if (await pathExists(fp)) {
                    await fs.unlink(fp);
                    console.log(`CheckpointManager: Удален файл "${fp}" при откате.`);
                }
            } catch (unlinkErr) {
                console.warn(`CheckpointManager: Не удалось удалить файл "${fp}" при откате: ${unlinkErr.message}`);
            }
        }
        // Если финальный мета-файл успел создаться (маловероятно, если rename - последний шаг), его тоже надо удалить
        // Но createdFilesForRollback уже должен его содержать, если rename упал.
        // Перебрасываем исходную ошибку
        throw error;
    }
}

/**
 * Загружает данные и метаданные индексов из последнего валидного чекпоинта.
 * @param {string} checkpointsDirPath - Путь к директории чекпоинтов.
 * @param {string} collectionName - Имя коллекции.
 * @returns {Promise<{documents: Map<string, object>, timestamp: string | null, metaFile: string | null, indexesMeta: Array<object>}>}
 */
async function loadLatestCheckpoint(checkpointsDirPath, collectionName) {
    const loadedDocuments = new Map();
    let latestCheckpointTimestamp = null;
    let loadedMetaFile = null;
    let loadedIndexesMeta = [];

    if (!(await pathExists(checkpointsDirPath))) {
        console.log(`CheckpointManager: Директория чекпоинтов "${checkpointsDirPath}" для коллекции "${collectionName}" не найдена.`);
        return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile, indexesMeta: loadedIndexesMeta };
    }

    let filesInDir;
    try {
        filesInDir = await fs.readdir(checkpointsDirPath);
    } catch (readdirError) {
        console.error(`CheckpointManager: Не удалось прочитать директорию "${checkpointsDirPath}": ${readdirError.message}`);
        return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile, indexesMeta: loadedIndexesMeta };
    }
    
    const finalMetaFileNames = filesInDir
        .filter(f => f.startsWith(`${CHECKPOINT_META_FILE_PREFIX}${collectionName}_`) && f.endsWith('.json') && !f.endsWith(TEMP_CHECKPOINT_META_SUFFIX))
        .sort()  
        .reverse(); 

    if (finalMetaFileNames.length === 0) {
        console.log(`CheckpointManager: Финальные мета-файлы для "${collectionName}" не найдены в "${checkpointsDirPath}".`);
        return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile, indexesMeta: loadedIndexesMeta };
    }

    for (const metaFileName of finalMetaFileNames) {
        const metaFilePath = path.join(checkpointsDirPath, metaFileName);
        try {
            const checkpointMeta = await readJsonFile(metaFilePath);
            if (!checkpointMeta || checkpointMeta.collectionName !== collectionName || 
                typeof checkpointMeta.timestamp !== 'string' || !Array.isArray(checkpointMeta.segmentFiles) ||
                typeof checkpointMeta.totalDocuments !== 'number'
            ) {
                console.warn(`CheckpointManager: Невалидный мета-файл "${metaFileName}" для "${collectionName}". Пропуск.`);
                continue;
            }

            const tempDocsFromCheckpoint = new Map();
            let allSegmentsValidAndPresent = true;
            if (checkpointMeta.segmentFiles.length === 0 && checkpointMeta.totalDocuments === 0) {
                // Валидный пустой чекпоинт
            } else if (checkpointMeta.segmentFiles.length > 0) {
                for (const segmentFileName of checkpointMeta.segmentFiles) {
                    const segmentFilePath = path.join(checkpointsDirPath, segmentFileName); 
                    if (!(await pathExists(segmentFilePath))) {
                        console.error(`CheckpointManager: Сегмент "${segmentFileName}" (из мета "${metaFileName}") не найден. Чекпоинт невалиден.`);
                        allSegmentsValidAndPresent = false; break;
                    }
                    const segmentData = await readJsonFile(segmentFilePath); 
                    if (!Array.isArray(segmentData)) { 
                        console.error(`CheckpointManager: Сегмент "${segmentFileName}" (из мета "${metaFileName}") поврежден. Чекпоинт невалиден.`);
                        allSegmentsValidAndPresent = false; break;
                    }
                    for (const doc of segmentData) {
                        if (doc && typeof doc._id === 'string' && doc._id.length > 0) { 
                            tempDocsFromCheckpoint.set(doc._id, doc);
                        } else {
                            console.warn(`CheckpointManager: Документ без _id в сегменте "${segmentFileName}" (мета: "${metaFileName}"). Пропуск.`);
                        }
                    }
                }
            } else if (checkpointMeta.totalDocuments > 0 && checkpointMeta.segmentFiles.length === 0) {
                 console.warn(`CheckpointManager: Несоответствие в мета "${metaFileName}": totalDocuments=${checkpointMeta.totalDocuments}, segmentFiles пуст. Невалиден.`);
                 allSegmentsValidAndPresent = false;
            }

            if (allSegmentsValidAndPresent) {
                if (tempDocsFromCheckpoint.size !== checkpointMeta.totalDocuments) {
                     console.warn(`CheckpointManager: Расхождение кол-ва док-ов в "${metaFileName}". Заявлено: ${checkpointMeta.totalDocuments}, загружено: ${tempDocsFromCheckpoint.size}.`);
                }
                console.log(`CheckpointManager: Успешно загружен чекпоинт "${metaFileName}" (ts: ${checkpointMeta.timestamp}), документов: ${tempDocsFromCheckpoint.size}.`);
                loadedDocuments.clear();
                tempDocsFromCheckpoint.forEach((value, key) => loadedDocuments.set(key, value));
                latestCheckpointTimestamp = checkpointMeta.timestamp;
                loadedMetaFile = metaFileName;
                // Загружаем метаданные индексов, если они есть в чекпоинте
                loadedIndexesMeta = Array.isArray(checkpointMeta.indexes) ? checkpointMeta.indexes : [];
                break; 
            }
        } catch (error) {
            console.error(`CheckpointManager: Ошибка обработки чекпоинта (мета: "${metaFileName}"): ${error.message}. Попытка загрузить следующий.`);
        }
    }
    
    if (!latestCheckpointTimestamp) {
        console.log(`CheckpointManager: Не найдено валидных чекпоинтов для коллекции "${collectionName}".`);
    }

    return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile, indexesMeta: loadedIndexesMeta };
}

async function cleanupOldCheckpoints(checkpointsDirPath, collectionName, numToKeep = 1) {
    if (numToKeep < 1) numToKeep = 1; 

    if (!(await pathExists(checkpointsDirPath))) {
        return; 
    }
    
    let filesInDir;
    try {
        filesInDir = await fs.readdir(checkpointsDirPath);
    } catch (readdirError) {
        console.error(`CheckpointManager: Не удалось прочитать "${checkpointsDirPath}" для очистки: ${readdirError.message}`);
        return;
    }

    const finalMetaFileNamesSorted = filesInDir
        .filter(f => f.startsWith(`${CHECKPOINT_META_FILE_PREFIX}${collectionName}_`) && f.endsWith('.json') && !f.endsWith(TEMP_CHECKPOINT_META_SUFFIX))
        .sort(); 

    if (finalMetaFileNamesSorted.length <= numToKeep) {
        return; 
    }

    const metaFilesToDelete = finalMetaFileNamesSorted.slice(0, finalMetaFileNamesSorted.length - numToKeep);
    
    if (metaFilesToDelete.length > 0) {
        console.log(`CheckpointManager: Планируется удаление ${metaFilesToDelete.length} старых чекпоинтов для "${collectionName}". Мета-файлы: ${metaFilesToDelete.join(', ')}`);
    }

    for (const metaFileName of metaFilesToDelete) {
        const metaFilePath = path.join(checkpointsDirPath, metaFileName);
        try {
            let segmentFilesToDelete = [];
            if (await pathExists(metaFilePath)) { 
                try {
                    const checkpointMeta = await readJsonFile(metaFilePath); 
                    if (checkpointMeta && Array.isArray(checkpointMeta.segmentFiles)) {
                        segmentFilesToDelete = checkpointMeta.segmentFiles;
                    } else {
                         console.warn(`CheckpointManager: Некорректные метаданные в "${metaFileName}" при очистке.`);
                    }
                } catch (readMetaError) {
                    console.warn(`CheckpointManager: Ошибка чтения мета-файла "${metaFileName}" при очистке: ${readMetaError.message}`);
                }
            } else {
                console.warn(`CheckpointManager: Мета-файл для удаления "${metaFileName}" не найден. Пропуск.`);
                continue; 
            }
            
            for (const segmentFileName of segmentFilesToDelete) {
                const segmentFilePath = path.join(checkpointsDirPath, segmentFileName); 
                if (await pathExists(segmentFilePath)) {
                    try { await fs.unlink(segmentFilePath); } 
                    catch (unlinkSegError) { console.error(`CheckpointManager: Ошибка удаления сегмента "${segmentFilePath}" (мета: "${metaFileName}"): ${unlinkSegError.message}`); }
                }
            }

            if (await pathExists(metaFilePath)) { 
                 await fs.unlink(metaFilePath);
                 console.log(`CheckpointManager: Удален старый чекпоинт (мета: ${metaFileName}) для "${collectionName}".`);
            }
        } catch (error) { 
            console.error(`CheckpointManager: Общая ошибка при удалении старого чекпоинта (мета: "${metaFileName}"): ${error.message}`);
        }
    }
}

module.exports = {
    getCheckpointsPath,
    performCheckpoint,
    loadLatestCheckpoint,
    cleanupOldCheckpoints,
};