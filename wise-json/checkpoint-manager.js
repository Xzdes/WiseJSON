// checkpoint-manager.js
const fs = require('fs/promises');
const path = require('path');
const {
    ensureDirectoryExists,
    writeJsonFileSafe,
    readJsonFile,
    pathExists,
    deleteFileIfExists,
} = require('./storage-utils.js');

const CHECKPOINT_DIR_NAME = '_checkpoints';
const META_PREFIX = 'checkpoint_meta_';
const DATA_PREFIX = 'checkpoint_data_';
const TEMP_META_SUFFIX = '.tmp_meta';

/**
 * Возвращает путь к директории чекпоинтов.
 * @param {string} collectionDirPath
 * @returns {string}
 */
function getCheckpointsPath(collectionDirPath) {
    return path.join(collectionDirPath, CHECKPOINT_DIR_NAME);
}

/**
 * Создаёт чекпоинт: данные + метаданные индексов.
 * @param {string} checkpointsDirPath
 * @param {string} collectionName
 * @param {Map<string, object>} documents
 * @param {string} checkpointTs - ISO строка
 * @param {object} options
 * @param {Array<object>} [indexMetadataToSave=[]]
 * @returns {Promise<object>}
 */
async function performCheckpoint(checkpointsDirPath, collectionName, documents, checkpointTs, options, indexMetadataToSave = []) {
    await ensureDirectoryExists(checkpointsDirPath);

    const jsonIndent = options.jsonIndent ?? null;
    const maxSegmentSizeBytes = options.maxSegmentSizeBytes > 0 ? options.maxSegmentSizeBytes : 1024 * 1024;

    const docs = Array.from(documents.values());
    const dataFiles = [];
    const rollbackFiles = [];

    const tsSafe = checkpointTs.replace(/[:.]/g, '-');
    const metaFilename = `${META_PREFIX}${collectionName}_${tsSafe}.json`;
    const tmpMetaPath = path.join(checkpointsDirPath, metaFilename + TEMP_META_SUFFIX);
    const finalMetaPath = path.join(checkpointsDirPath, metaFilename);

    let segment = [];
    let segmentSize = 2;

    try {
        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            const docStr = JSON.stringify(doc);
            const docSize = Buffer.byteLength(docStr, 'utf8') + (segment.length > 0 ? 1 : 0);

            if (segmentSize + docSize > maxSegmentSizeBytes && segment.length > 0) {
                const file = `${DATA_PREFIX}${collectionName}_${tsSafe}_seg${dataFiles.length}.json`;
                const filePath = path.join(checkpointsDirPath, file);
                await writeJsonFileSafe(filePath, segment, jsonIndent);
                dataFiles.push(file);
                rollbackFiles.push(filePath);
                segment = [];
                segmentSize = 2;
            }

            segment.push(doc);
            segmentSize += docSize;
        }

        if (segment.length > 0 || docs.length === 0) {
            const file = `${DATA_PREFIX}${collectionName}_${tsSafe}_seg${dataFiles.length}.json`;
            const filePath = path.join(checkpointsDirPath, file);
            await writeJsonFileSafe(filePath, segment, jsonIndent);
            dataFiles.push(file);
            rollbackFiles.push(filePath);
        }

        const meta = {
            timestamp: checkpointTs,
            collectionName,
            segmentFiles: dataFiles,
            totalDocuments: docs.length,
            indexes: indexMetadataToSave || [],
        };

        await writeJsonFileSafe(tmpMetaPath, meta, jsonIndent);
        rollbackFiles.push(tmpMetaPath);

        await fs.rename(tmpMetaPath, finalMetaPath);
        rollbackFiles.pop(); // tmpMetaPath уже не существует
        rollbackFiles.push(finalMetaPath);

        console.log(`[Checkpoint] ✅ Чекпоинт сохранён: ${metaFilename}, документов: ${docs.length}, сегментов: ${dataFiles.length}`);
        return { ...meta, metaFile: metaFilename };
    } catch (err) {
        console.error(`[Checkpoint] ❌ Ошибка чекпоинта: ${err.message}`);
        for (const file of rollbackFiles) {
            try {
                await deleteFileIfExists(file);
            } catch {}
        }
        throw err;
    }
}

/**
 * Загружает последний валидный чекпоинт коллекции.
 * @param {string} checkpointsDirPath
 * @param {string} collectionName
 * @returns {Promise<{documents: Map<string, object>, timestamp: string|null, metaFile: string|null, indexesMeta: Array<object>}>}
 */
async function loadLatestCheckpoint(checkpointsDirPath, collectionName) {
    const docsMap = new Map();
    let latestTs = null;
    let metaFile = null;
    let indexesMeta = [];

    if (!(await pathExists(checkpointsDirPath))) return { documents: docsMap, timestamp: null, metaFile: null, indexesMeta: [] };

    let files;
    try {
        files = await fs.readdir(checkpointsDirPath);
    } catch {
        return { documents: docsMap, timestamp: null, metaFile: null, indexesMeta: [] };
    }

    const metaFiles = files
        .filter(f => f.startsWith(`${META_PREFIX}${collectionName}_`) && f.endsWith('.json') && !f.endsWith(TEMP_META_SUFFIX))
        .sort().reverse();

    for (const f of metaFiles) {
        const fullPath = path.join(checkpointsDirPath, f);
        try {
            const meta = await readJsonFile(fullPath);
            if (!meta || meta.collectionName !== collectionName || !Array.isArray(meta.segmentFiles)) continue;

            const tempDocs = new Map();
            let valid = true;

            for (const seg of meta.segmentFiles) {
                const segPath = path.join(checkpointsDirPath, seg);
                if (!(await pathExists(segPath))) {
                    valid = false;
                    break;
                }
                const data = await readJsonFile(segPath);
                if (!Array.isArray(data)) {
                    valid = false;
                    break;
                }
                for (const doc of data) {
                    if (doc && typeof doc._id === 'string') {
                        tempDocs.set(doc._id, doc);
                    }
                }
            }

            if (valid) {
                docsMap.clear();
                for (const [k, v] of tempDocs.entries()) docsMap.set(k, v);
                latestTs = meta.timestamp;
                metaFile = f;
                indexesMeta = meta.indexes || [];
                break;
            }
        } catch {}
    }

    return { documents: docsMap, timestamp: latestTs, metaFile, indexesMeta };
}

/**
 * Удаляет старые чекпоинты, оставляя только `keepCount` последних.
 * @param {string} checkpointsDirPath
 * @param {string} collectionName
 * @param {number} keepCount
 * @returns {Promise<void>}
 */
async function cleanupOldCheckpoints(checkpointsDirPath, collectionName, keepCount) {
    if (keepCount < 1) return;

    try {
        const files = await fs.readdir(checkpointsDirPath);
        const metas = files
            .filter(f => f.startsWith(`${META_PREFIX}${collectionName}_`) && f.endsWith('.json') && !f.endsWith(TEMP_META_SUFFIX))
            .sort().reverse();

        const toRemove = metas.slice(keepCount);
        for (const meta of toRemove) {
            const metaPath = path.join(checkpointsDirPath, meta);
            const metaData = await readJsonFile(metaPath);
            if (metaData && Array.isArray(metaData.segmentFiles)) {
                for (const seg of metaData.segmentFiles) {
                    await deleteFileIfExists(path.join(checkpointsDirPath, seg));
                }
            }
            await deleteFileIfExists(metaPath);
        }
    } catch (err) {
        console.warn(`[Checkpoint] ⚠ Не удалось очистить старые чекпоинты: ${err.message}`);
    }
}

module.exports = {
    getCheckpointsPath,
    performCheckpoint,
    loadLatestCheckpoint,
    cleanupOldCheckpoints,
};
