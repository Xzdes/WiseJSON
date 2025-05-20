// wise-json/checkpoint-manager.js
const fs = require('fs/promises');
const path = require('path');
const { ensureDirectoryExists, writeJsonFileSafe, readJsonFile, pathExists } = require('./storage-utils.js');

const CHECKPOINT_DIR_NAME = '_checkpoints';
const CHECKPOINT_META_FILE_PREFIX = 'checkpoint_meta_';
const CHECKPOINT_DATA_FILE_PREFIX = 'checkpoint_data_';
const TEMP_CHECKPOINT_META_SUFFIX = '.tmp_meta'; // Для временного мета-файла

/**
 * Возвращает стандартный путь к директории чекпоинтов для коллекции.
 * @param {string} collectionDirPath - Путь к директории коллекции.
 * @returns {string}
 */
function getCheckpointsPath(collectionDirPath) {
    return path.join(collectionDirPath, CHECKPOINT_DIR_NAME);
}

/**
 * Выполняет чекпоинт: сохраняет текущее состояние документов на диск.
 * Сначала записывает все файлы данных, затем временный мета-файл,
 * и только после этого переименовывает временный мета-файл в основной,
 * делая чекпоинт "видимым" и валидным.
 * @param {string} checkpointsDirPath - Путь к директории, где хранятся чекпоинты.
 * @param {string} collectionName - Имя коллекции (для именования файлов).
 * @param {Map<string, object>} documents - Данные коллекции (Map документов).
 * @param {string} checkpointTs - Временная метка текущего чекпоинта (ISO строка).
 * @param {object} options - Опции коллекции (jsonIndent, maxSegmentSizeBytes).
 * @returns {Promise<{timestamp: string, files: string[], totalDocuments: number, metaFile: string}>} Метаданные сохраненного чекпоинта.
 * @throws {Error} Если произошла ошибка при создании чекпоинта.
 */
async function performCheckpoint(checkpointsDirPath, collectionName, documents, checkpointTs, options) {
    await ensureDirectoryExists(checkpointsDirPath);

    const jsonDataIndent = options.jsonIndent !== undefined ? options.jsonIndent : null;
    const maxSegmentSizeBytes = options.maxSegmentSizeBytes && options.maxSegmentSizeBytes > 0 
        ? options.maxSegmentSizeBytes 
        : (1 * 1024 * 1024); 

    const checkpointDataFileNames = []; 
    const docsArray = Array.from(documents.values());
    let currentSegmentDocs = [];
    let currentSegmentJsonLength = 2; 

    const sanitizedTs = checkpointTs.replace(/[:.]/g, '-');
    const finalMetaFileName = `${CHECKPOINT_META_FILE_PREFIX}${collectionName}_${sanitizedTs}.json`;
    const tempMetaFilePath = path.join(checkpointsDirPath, `${finalMetaFileName}${TEMP_CHECKPOINT_META_SUFFIX}`);
    const finalMetaFilePath = path.join(checkpointsDirPath, finalMetaFileName);

    let createdSegmentPaths = []; // Для отката в случае ошибки

    try {
        for (let i = 0; i < docsArray.length; i++) {
            const doc = docsArray[i];
            const docJsonString = JSON.stringify(doc); 
            const docByteLength = Buffer.byteLength(docJsonString, 'utf8');
            const estimatedAddedLength = docByteLength + (currentSegmentDocs.length > 0 ? 1 : 0);

            if (currentSegmentJsonLength + estimatedAddedLength > maxSegmentSizeBytes && currentSegmentDocs.length > 0) {
                const segmentFileName = `${CHECKPOINT_DATA_FILE_PREFIX}${collectionName}_${sanitizedTs}_seg${checkpointDataFileNames.length}.json`;
                const segmentFilePath = path.join(checkpointsDirPath, segmentFileName);
                // Сегменты пишем сразу с финальными именами, т.к. их валидность будет определяться мета-файлом.
                // writeJsonFileSafe использует временный файл для записи каждого сегмента.
                await writeJsonFileSafe(segmentFilePath, currentSegmentDocs, jsonDataIndent);
                checkpointDataFileNames.push(segmentFileName);
                createdSegmentPaths.push(segmentFilePath);
                
                currentSegmentDocs = []; 
                currentSegmentJsonLength = 2;
            }
            currentSegmentDocs.push(doc);
            currentSegmentJsonLength += estimatedAddedLength;
        }

        if (currentSegmentDocs.length > 0) {
            const segmentFileName = `${CHECKPOINT_DATA_FILE_PREFIX}${collectionName}_${sanitizedTs}_seg${checkpointDataFileNames.length}.json`;
            const segmentFilePath = path.join(checkpointsDirPath, segmentFileName);
            await writeJsonFileSafe(segmentFilePath, currentSegmentDocs, jsonDataIndent);
            checkpointDataFileNames.push(segmentFileName);
            createdSegmentPaths.push(segmentFilePath);
        } else if (docsArray.length === 0 && checkpointDataFileNames.length === 0) { 
            const segmentFileName = `${CHECKPOINT_DATA_FILE_PREFIX}${collectionName}_${sanitizedTs}_seg0.json`;
            const segmentFilePath = path.join(checkpointsDirPath, segmentFileName);
            await writeJsonFileSafe(segmentFilePath, [], jsonDataIndent); 
            checkpointDataFileNames.push(segmentFileName);
            createdSegmentPaths.push(segmentFilePath);
        }

        // Все сегменты данных успешно записаны. Теперь создаем мета-файл.
        const checkpointMeta = {
            timestamp: checkpointTs, 
            collectionName: collectionName,
            segmentFiles: checkpointDataFileNames, 
            totalDocuments: docsArray.length,
        };
        
        // Сначала пишем метаданные во временный файл
        await writeJsonFileSafe(tempMetaFilePath, checkpointMeta, jsonDataIndent);

        // Атомарно "публикуем" чекпоинт, переименовывая временный мета-файл в основной
        await fs.rename(tempMetaFilePath, finalMetaFilePath);
        
        console.log(`CheckpointManager: Чекпоинт для "${collectionName}" (ts: ${checkpointTs}) успешно создан и опубликован. Мета: ${finalMetaFileName}. Сегменты: ${checkpointDataFileNames.length}`);
        return { ...checkpointMeta, metaFile: finalMetaFileName };
    } catch (error) {
        // Если произошла ошибка на любом этапе, пытаемся удалить все созданные файлы этого чекпоинта
        console.error(`CheckpointManager: Ошибка при создании чекпоинта (ts: ${checkpointTs}) для "${collectionName}": ${error.message}. Попытка отката...`);
        for (const fp of createdSegmentPaths) {
            try {
                if (await pathExists(fp)) await fs.unlink(fp);
            } catch (unlinkErr) {
                console.warn(`CheckpointManager: Не удалось удалить временный файл сегмента "${fp}" при откате: ${unlinkErr.message}`);
            }
        }
        // Удаляем временный мета-файл, если он был создан
        try {
            if (await pathExists(tempMetaFilePath)) await fs.unlink(tempMetaFilePath);
        } catch (unlinkErr) {
             console.warn(`CheckpointManager: Не удалось удалить временный мета-файл "${tempMetaFilePath}" при откате: ${unlinkErr.message}`);
        }
        // Перебрасываем исходную ошибку
        throw error;
    }
}

/**
 * Загружает данные из последнего валидного чекпоинта.
 * Валидным считается чекпоинт, у которого существует финальный мета-файл и все указанные в нем сегменты.
 * @param {string} checkpointsDirPath - Путь к директории чекпоинтов.
 * @param {string} collectionName - Имя коллекции.
 * @returns {Promise<{documents: Map<string, object>, timestamp: string | null, metaFile: string | null}>}
 *          Объект с картой документов, временной меткой чекпоинта и именем мета-файла (или null, если чекпоинтов нет).
 */
async function loadLatestCheckpoint(checkpointsDirPath, collectionName) {
    const loadedDocuments = new Map();
    let latestCheckpointTimestamp = null;
    let loadedMetaFile = null;

    if (!(await pathExists(checkpointsDirPath))) {
        console.log(`CheckpointManager: Директория чекпоинтов "${checkpointsDirPath}" для коллекции "${collectionName}" не найдена. Загрузка без чекпоинта.`);
        return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile };
    }

    let filesInDir;
    try {
        filesInDir = await fs.readdir(checkpointsDirPath);
    } catch (readdirError) {
        console.error(`CheckpointManager: Не удалось прочитать директорию чекпоинтов "${checkpointsDirPath}": ${readdirError.message}`);
        return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile };
    }
    
    // Ищем только финальные мета-файлы (без .tmp_meta)
    const finalMetaFileNames = filesInDir
        .filter(f => f.startsWith(`${CHECKPOINT_META_FILE_PREFIX}${collectionName}_`) && f.endsWith('.json') && !f.endsWith(TEMP_CHECKPOINT_META_SUFFIX))
        .sort()  
        .reverse(); 

    if (finalMetaFileNames.length === 0) {
        console.log(`CheckpointManager: Финальные мета-файлы чекпоинтов для коллекции "${collectionName}" не найдены в "${checkpointsDirPath}".`);
        return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile };
    }

    for (const metaFileName of finalMetaFileNames) {
        const metaFilePath = path.join(checkpointsDirPath, metaFileName);
        try {
            const checkpointMeta = await readJsonFile(metaFilePath);
            if (
                !checkpointMeta || 
                checkpointMeta.collectionName !== collectionName || 
                typeof checkpointMeta.timestamp !== 'string' || 
                !Array.isArray(checkpointMeta.segmentFiles) ||
                typeof checkpointMeta.totalDocuments !== 'number'
            ) {
                console.warn(`CheckpointManager: Невалидный или неполный мета-файл чекпоинта "${metaFileName}" для коллекции "${collectionName}". Пропуск.`);
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
                        console.error(`CheckpointManager: Файл сегмента "${segmentFileName}" (из мета "${metaFileName}") не найден. Чекпоинт "${metaFileName}" невалиден.`);
                        allSegmentsValidAndPresent = false;
                        break;
                    }
                    const segmentData = await readJsonFile(segmentFilePath); 
                    if (!Array.isArray(segmentData)) { 
                        console.error(`CheckpointManager: Сегмент "${segmentFileName}" (из мета "${metaFileName}") поврежден или не является массивом. Чекпоинт "${metaFileName}" невалиден.`);
                        allSegmentsValidAndPresent = false;
                        break;
                    }
                    for (const doc of segmentData) {
                        if (doc && typeof doc._id === 'string' && doc._id.length > 0) { 
                            tempDocsFromCheckpoint.set(doc._id, doc);
                        } else {
                            console.warn(`CheckpointManager: Документ без валидного _id в сегменте "${segmentFileName}" (мета: "${metaFileName}"). Пропуск документа.`);
                        }
                    }
                }
            } else if (checkpointMeta.totalDocuments > 0 && checkpointMeta.segmentFiles.length === 0) {
                 console.warn(`CheckpointManager: Несоответствие в мета-файле "${metaFileName}": totalDocuments=${checkpointMeta.totalDocuments}, но segmentFiles пуст. Чекпоинт считается невалидным.`);
                 allSegmentsValidAndPresent = false;
            }

            if (allSegmentsValidAndPresent) {
                if (tempDocsFromCheckpoint.size !== checkpointMeta.totalDocuments) {
                     console.warn(`CheckpointManager: Расхождение количества документов в чекпоинте "${metaFileName}". Заявлено: ${checkpointMeta.totalDocuments}, загружено: ${tempDocsFromCheckpoint.size}. Используем загруженное количество.`);
                }
                console.log(`CheckpointManager: Успешно загружен чекпоинт "${metaFileName}" (ts: ${checkpointMeta.timestamp}), документов: ${tempDocsFromCheckpoint.size}.`);
                loadedDocuments.clear();
                tempDocsFromCheckpoint.forEach((value, key) => loadedDocuments.set(key, value));
                latestCheckpointTimestamp = checkpointMeta.timestamp;
                loadedMetaFile = metaFileName;
                break; 
            }
        } catch (error) {
            console.error(`CheckpointManager: Ошибка при обработке чекпоинта (мета: "${metaFileName}"): ${error.message}. Попытка загрузить следующий.`);
        }
    }
    
    if (!latestCheckpointTimestamp) {
        console.log(`CheckpointManager: Не найдено валидных чекпоинтов для коллекции "${collectionName}".`);
    }

    return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile };
}

/**
 * Очищает старые чекпоинты, оставляя указанное количество последних.
 * @param {string} checkpointsDirPath - Путь к директории чекпоинтов.
 * @param {string} collectionName - Имя коллекции.
 * @param {number} [numToKeep=1] - Количество последних чекпоинтов, которые нужно оставить (минимум 1).
 * @returns {Promise<void>}
 */
async function cleanupOldCheckpoints(checkpointsDirPath, collectionName, numToKeep = 1) {
    if (numToKeep < 1) numToKeep = 1; 

    if (!(await pathExists(checkpointsDirPath))) {
        return; 
    }
    
    let filesInDir;
    try {
        filesInDir = await fs.readdir(checkpointsDirPath);
    } catch (readdirError) {
        console.error(`CheckpointManager: Не удалось прочитать директорию чекпоинтов "${checkpointsDirPath}" для очистки: ${readdirError.message}`);
        return;
    }

    // Ищем только финальные (не .tmp_meta) мета-файлы для этой коллекции
    const finalMetaFileNamesSorted = filesInDir
        .filter(f => f.startsWith(`${CHECKPOINT_META_FILE_PREFIX}${collectionName}_`) && f.endsWith('.json') && !f.endsWith(TEMP_CHECKPOINT_META_SUFFIX))
        .sort(); 

    if (finalMetaFileNamesSorted.length <= numToKeep) {
        return; // Нечего удалять
    }

    const metaFilesToDelete = finalMetaFileNamesSorted.slice(0, finalMetaFileNamesSorted.length - numToKeep);
    
    if (metaFilesToDelete.length > 0) {
        console.log(`CheckpointManager: Планируется удаление ${metaFilesToDelete.length} старых чекпоинтов для "${collectionName}". Мета-файлы: ${metaFilesToDelete.join(', ')}`);
    }

    for (const metaFileName of metaFilesToDelete) {
        const metaFilePath = path.join(checkpointsDirPath, metaFileName);
        try {
            // Сначала пытаемся прочитать мета-файл, чтобы получить список его сегментов
            // Если мета-файл уже удален или поврежден, мы не можем надежно удалить его сегменты по имени.
            let segmentFilesToDelete = [];
            if (await pathExists(metaFilePath)) {
                try {
                    const checkpointMeta = await readJsonFile(metaFilePath); 
                    if (checkpointMeta && Array.isArray(checkpointMeta.segmentFiles)) {
                        segmentFilesToDelete = checkpointMeta.segmentFiles;
                    } else {
                         console.warn(`CheckpointManager: Не удалось прочитать или некорректные метаданные в "${metaFileName}" при очистке. Сегменты могут не удалиться.`);
                    }
                } catch (readMetaError) {
                    console.warn(`CheckpointManager: Ошибка чтения мета-файла "${metaFileName}" при очистке, сегменты могут не удалиться: ${readMetaError.message}`);
                }
            } else {
                console.warn(`CheckpointManager: Мета-файл для удаления "${metaFileName}" не найден во время очистки. Возможно, уже удален.`);
                continue; // Переходим к следующему мета-файлу для удаления
            }
            
            // Удаляем сегменты
            for (const segmentFileName of segmentFilesToDelete) {
                const segmentFilePath = path.join(checkpointsDirPath, segmentFileName);
                if (await pathExists(segmentFilePath)) {
                    try {
                        await fs.unlink(segmentFilePath);
                    } catch (unlinkSegError) {
                         console.error(`CheckpointManager: Ошибка при удалении файла сегмента "${segmentFilePath}" (мета: "${metaFileName}"): ${unlinkSegError.message}`);
                    }
                }
            }

            // Удаляем сам мета-файл
            if (await pathExists(metaFilePath)) {
                await fs.unlink(metaFilePath);
                console.log(`CheckpointManager: Удален старый чекпоинт (мета: ${metaFileName}) для "${collectionName}".`);
            }
        } catch (error) { // Общий catch для ошибок обработки одного старого чекпоинта
            console.error(`CheckpointManager: Общая ошибка при удалении старого чекпоинта (обработка мета-файла "${metaFileName}"): ${error.message}`);
        }
    }
}

module.exports = {
    getCheckpointsPath,
    performCheckpoint,
    loadLatestCheckpoint,
    cleanupOldCheckpoints,
};