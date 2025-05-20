// wise-json/checkpoint-manager.js
const fs = require('fs/promises');
const path = require('path');
// Используем CommonJS require для импорта из нашего же модуля
const { ensureDirectoryExists, writeJsonFileSafe, readJsonFile, pathExists } = require('./storage-utils.js');

const CHECKPOINT_DIR_NAME = '_checkpoints';
const CHECKPOINT_META_FILE_PREFIX = 'checkpoint_meta_';
const CHECKPOINT_DATA_FILE_PREFIX = 'checkpoint_data_'; // Используется для именования сегментов данных

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
 * Создает мета-файл чекпоинта и один или несколько файлов-сегментов данных.
 * @param {string} checkpointsDirPath - Путь к директории, где хранятся чекпоинты.
 * @param {string} collectionName - Имя коллекции (для именования файлов).
 * @param {Map<string, object>} documents - Данные коллекции (Map документов, где ключ - _id).
 * @param {string} checkpointTs - Временная метка текущего чекпоинта (ISO строка, используется для имен файлов).
 * @param {object} options - Опции коллекции.
 * @param {number|null} [options.jsonIndent] - Отступ для JSON.stringify.
 * @param {number} [options.maxSegmentSizeBytes] - Максимальный размер сегмента данных чекпоинта.
 * @returns {Promise<{timestamp: string, files: string[], totalDocuments: number, metaFile: string}>} Метаданные сохраненного чекпоинта.
 * @throws {Error} Если произошла ошибка при создании чекпоинта.
 */
async function performCheckpoint(checkpointsDirPath, collectionName, documents, checkpointTs, options) {
    await ensureDirectoryExists(checkpointsDirPath);

    const jsonDataIndent = options.jsonIndent !== undefined ? options.jsonIndent : null;
    // Убедимся, что maxSegmentSizeBytes имеет разумное значение по умолчанию, если не предоставлено
    const maxSegmentSizeBytes = options.maxSegmentSizeBytes && options.maxSegmentSizeBytes > 0 
        ? options.maxSegmentSizeBytes 
        : (1 * 1024 * 1024); // 1MB default

    const checkpointDataFileNames = []; // Имена файлов данных этого чекпоинта (относительно checkpointsDirPath)
    const docsArray = Array.from(documents.values()); // Преобразуем Map в массив для удобства итерации
    let currentSegmentDocs = [];
    let currentSegmentJsonLength = 2; // Начальный размер для `[]`

    // Используем временную метку без символов, не подходящих для имен файлов
    const sanitizedTs = checkpointTs.replace(/[:.]/g, '-');
    
    for (let i = 0; i < docsArray.length; i++) {
        const doc = docsArray[i];
        // Оцениваем размер документа в JSON-строке
        const docJsonString = JSON.stringify(doc); // Без отступов для оценки размера, т.к. отступы влияют
        const docByteLength = Buffer.byteLength(docJsonString, 'utf8');
        
        // +1 за запятую, если это не первый документ в сегменте
        const estimatedAddedLength = docByteLength + (currentSegmentDocs.length > 0 ? 1 : 0);

        if (currentSegmentJsonLength + estimatedAddedLength > maxSegmentSizeBytes && currentSegmentDocs.length > 0) {
            // Текущий сегмент полон, сохраняем его
            const segmentFileName = `${CHECKPOINT_DATA_FILE_PREFIX}${collectionName}_${sanitizedTs}_seg${checkpointDataFileNames.length}.json`;
            const segmentFilePath = path.join(checkpointsDirPath, segmentFileName);
            await writeJsonFileSafe(segmentFilePath, currentSegmentDocs, jsonDataIndent);
            checkpointDataFileNames.push(segmentFileName);
            
            currentSegmentDocs = []; // Начинаем новый сегмент
            currentSegmentJsonLength = 2; // Сброс размера
        }
        currentSegmentDocs.push(doc);
        currentSegmentJsonLength += estimatedAddedLength;
    }

    // Сохраняем последний (или единственный) сегмент, если в нем есть данные
    if (currentSegmentDocs.length > 0) {
        const segmentFileName = `${CHECKPOINT_DATA_FILE_PREFIX}${collectionName}_${sanitizedTs}_seg${checkpointDataFileNames.length}.json`;
        const segmentFilePath = path.join(checkpointsDirPath, segmentFileName);
        await writeJsonFileSafe(segmentFilePath, currentSegmentDocs, jsonDataIndent);
        checkpointDataFileNames.push(segmentFileName);
    } else if (docsArray.length === 0 && checkpointDataFileNames.length === 0) { 
        // Если коллекция была пуста изначально, создаем один пустой сегмент, чтобы обозначить чекпоинт
        const segmentFileName = `${CHECKPOINT_DATA_FILE_PREFIX}${collectionName}_${sanitizedTs}_seg0.json`;
        const segmentFilePath = path.join(checkpointsDirPath, segmentFileName);
        await writeJsonFileSafe(segmentFilePath, [], jsonDataIndent); // Пустой массив
        checkpointDataFileNames.push(segmentFileName);
    }

    // Сохраняем мета-файл для этого чекпоинта
    const metaFileName = `${CHECKPOINT_META_FILE_PREFIX}${collectionName}_${sanitizedTs}.json`;
    const metaFilePath = path.join(checkpointsDirPath, metaFileName);
    const checkpointMeta = {
        timestamp: checkpointTs, // Точная временная метка
        collectionName: collectionName,
        segmentFiles: checkpointDataFileNames, // Список имен файлов данных
        totalDocuments: docsArray.length,
    };
    await writeJsonFileSafe(metaFilePath, checkpointMeta, jsonDataIndent);
    
    console.log(`CheckpointManager: Чекпоинт для "${collectionName}" (ts: ${checkpointTs}) успешно создан. Мета: ${metaFileName}. Сегменты: ${checkpointDataFileNames.length}`);
    return { ...checkpointMeta, metaFile: metaFileName }; // Возвращаем метаданные, включая имя мета-файла
}

/**
 * Загружает данные из последнего валидного чекпоинта.
 * @param {string} checkpointsDirPath - Путь к директории чекпоинтов.
 * @param {string} collectionName - Имя коллекции.
 * @returns {Promise<{documents: Map<string, object>, timestamp: string | null, metaFile: string | null}>}
 *          Объект с картой документов, временной меткой чекпоинта и именем мета-файла (или null, если чекпоинтов нет).
 * @throws {Error} Если произошла критическая ошибка чтения (не невалидность чекпоинта).
 */
async function loadLatestCheckpoint(checkpointsDirPath, collectionName) {
    const loadedDocuments = new Map();
    let latestCheckpointTimestamp = null;
    let loadedMetaFile = null;

    if (!(await pathExists(checkpointsDirPath))) {
        console.log(`CheckpointManager: Директория чекпоинтов "${checkpointsDirPath}" для коллекции "${collectionName}" не найдена. Загрузка без чекпоинта.`);
        return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile };
    }

    let files;
    try {
        files = await fs.readdir(checkpointsDirPath);
    } catch (readdirError) {
        console.error(`CheckpointManager: Не удалось прочитать директорию чекпоинтов "${checkpointsDirPath}": ${readdirError.message}`);
        // Считаем, что чекпоинтов нет, если не можем прочитать директорию
        return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile };
    }
    
    const metaFileNames = files
        .filter(f => f.startsWith(`${CHECKPOINT_META_FILE_PREFIX}${collectionName}_`) && f.endsWith('.json'))
        .sort()  // Сортировка по имени файла (старые сначала, т.к. timestamp в имени)
        .reverse(); // Самые новые (по имени) в начале

    if (metaFileNames.length === 0) {
        console.log(`CheckpointManager: Мета-файлы чекпоинтов для коллекции "${collectionName}" не найдены в "${checkpointsDirPath}".`);
        return { documents: loadedDocuments, timestamp: latestCheckpointTimestamp, metaFile: loadedMetaFile };
    }

    for (const metaFileName of metaFileNames) {
        const metaFilePath = path.join(checkpointsDirPath, metaFileName);
        try {
            const checkpointMeta = await readJsonFile(metaFilePath);
            // Тщательная проверка метаданных
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
            let allSegmentsValid = true;
            if (checkpointMeta.segmentFiles.length === 0 && checkpointMeta.totalDocuments === 0) {
                // Это валидный пустой чекпоинт
            } else if (checkpointMeta.segmentFiles.length > 0) {
                for (const segmentFileName of checkpointMeta.segmentFiles) {
                    const segmentFilePath = path.join(checkpointsDirPath, segmentFileName);
                    if (!(await pathExists(segmentFilePath))) {
                        console.error(`CheckpointManager: Файл сегмента "${segmentFileName}" из мета "${metaFileName}" не найден. Чекпоинт невалиден.`);
                        allSegmentsValid = false;
                        break;
                    }
                    const segmentData = await readJsonFile(segmentFilePath); // readJsonFile вернет null если не найден, но мы уже проверили pathExists
                    if (!Array.isArray(segmentData)) { // readJsonFile бросит ошибку если не JSON, или вернет null если не найден
                        console.error(`CheckpointManager: Сегмент "${segmentFileName}" из мета "${metaFileName}" поврежден или не является массивом. Чекпоинт невалиден.`);
                        allSegmentsValid = false;
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
                // Несоответствие: есть документы по счетчику, но нет файлов сегментов
                 console.warn(`CheckpointManager: Несоответствие в мета-файле "${metaFileName}": totalDocuments=${checkpointMeta.totalDocuments}, но segmentFiles пуст. Чекпоинт считается невалидным.`);
                 allSegmentsValid = false;
            }


            if (allSegmentsValid) {
                if (tempDocsFromCheckpoint.size !== checkpointMeta.totalDocuments) {
                     console.warn(`CheckpointManager: Расхождение количества документов в чекпоинте "${metaFileName}". Заявлено: ${checkpointMeta.totalDocuments}, загружено: ${tempDocsFromCheckpoint.size}. Используем загруженное количество.`);
                }
                console.log(`CheckpointManager: Успешно загружен чекпоинт "${metaFileName}" (ts: ${checkpointMeta.timestamp}), документов: ${tempDocsFromCheckpoint.size}.`);
                // Очищаем основной Map и заполняем его данными из успешно загруженного чекпоинта
                loadedDocuments.clear();
                tempDocsFromCheckpoint.forEach((value, key) => loadedDocuments.set(key, value));
                latestCheckpointTimestamp = checkpointMeta.timestamp;
                loadedMetaFile = metaFileName;
                break; // Выходим, так как нашли самый свежий валидный
            }
        } catch (error) {
            // Ошибка чтения/парсинга мета-файла или его сегментов
            console.error(`CheckpointManager: Ошибка при обработке чекпоинта (мета: "${metaFileName}"): ${error.message}. Попытка загрузить следующий.`);
            // Не перебрасываем ошибку, чтобы попытаться загрузить более старый, но валидный чекпоинт
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
 * @param {number} [numToKeep=1] - Количество последних чекпоинтов, которые нужно оставить. Должно быть >= 1.
 * @returns {Promise<void>}
 */
async function cleanupOldCheckpoints(checkpointsDirPath, collectionName, numToKeep = 1) {
    if (numToKeep < 1) numToKeep = 1; // Всегда храним хотя бы последний валидный чекпоинт

    if (!(await pathExists(checkpointsDirPath))) {
        return; // Нечего очищать
    }
    
    let files;
    try {
        files = await fs.readdir(checkpointsDirPath);
    } catch (readdirError) {
        console.error(`CheckpointManager: Не удалось прочитать директорию чекпоинтов "${checkpointsDirPath}" для очистки: ${readdirError.message}`);
        return;
    }

    const metaFileNamesSorted = files
        .filter(f => f.startsWith(`${CHECKPOINT_META_FILE_PREFIX}${collectionName}_`) && f.endsWith('.json'))
        .sort(); // Сортировка по имени (старые сначала)

    if (metaFileNamesSorted.length <= numToKeep) {
        return; // Нечего удалять или уже достаточно мало файлов
    }

    const metaFilesToDelete = metaFileNamesSorted.slice(0, metaFileNamesSorted.length - numToKeep);
    
    if (metaFilesToDelete.length > 0) {
        console.log(`CheckpointManager: Планируется удаление ${metaFilesToDelete.length} старых чекпоинтов для "${collectionName}". Файлы метаданных для удаления: ${metaFilesToDelete.join(', ')}`);
    }

    for (const metaFileName of metaFilesToDelete) {
        const metaFilePath = path.join(checkpointsDirPath, metaFileName);
        try {
            if (!(await pathExists(metaFilePath))) {
                console.warn(`CheckpointManager: Мета-файл для удаления "${metaFileName}" уже не существует. Пропуск.`);
                continue;
            }
            
            const checkpointMeta = await readJsonFile(metaFilePath); 
            // Если не удалось прочитать мета-файл, мы не можем быть уверены, какие сегменты удалять.
            // В этом случае, безопаснее удалить только сам мета-файл.
            // Однако, если он был создан нашей же системой, он должен быть валидным.
            if (checkpointMeta && Array.isArray(checkpointMeta.segmentFiles)) {
                for (const segmentFileName of checkpointMeta.segmentFiles) {
                    const segmentFilePath = path.join(checkpointsDirPath, segmentFileName);
                    if (await pathExists(segmentFilePath)) {
                        try {
                            await fs.unlink(segmentFilePath);
                        } catch (unlinkSegError) {
                             console.error(`CheckpointManager: Ошибка при удалении файла сегмента "${segmentFilePath}" для мета "${metaFileName}": ${unlinkSegError.message}`);
                             // Продолжаем, пытаемся удалить остальные части чекпоинта
                        }
                    }
                }
            } else {
                console.warn(`CheckpointManager: Не удалось прочитать метаданные из "${metaFileName}" или они некорректны. Файлы данных этого чекпоинта могут остаться.`);
            }

            // Удаляем мета-файл после (попытки) удаления его сегментов
            await fs.unlink(metaFilePath);
            console.log(`CheckpointManager: Удален старый чекпоинт (мета: ${metaFileName}) для "${collectionName}".`);
        } catch (error) {
            console.error(`CheckpointManager: Ошибка при удалении старого чекпоинта (обработка мета-файла "${metaFileName}"): ${error.message}`);
        }
    }
}

module.exports = {
    getCheckpointsPath,
    performCheckpoint,
    loadLatestCheckpoint,
    cleanupOldCheckpoints,
};