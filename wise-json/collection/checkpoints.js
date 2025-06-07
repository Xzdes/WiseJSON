const path = require('path');
const fs = require('fs/promises');
const { cleanupExpiredDocs } = require('./ttl.js');

/**
 * Генерирует имя файла чекпоинта с учётом сегмента (или без).
 * @param {string} collectionName
 * @param {string} type - 'meta' или 'data'
 * @param {string} timestamp
 * @param {number|undefined} segment
 * @returns {string}
 */
function getCheckpointFileName(collectionName, type, timestamp, segment) {
    if (segment !== undefined) {
        return `checkpoint_${type}_${collectionName}_${timestamp}_seg${segment}.json`;
    }
    return `checkpoint_${type}_${collectionName}_${timestamp}.json`;
}

/**
 * Контроллер чекпоинтов для коллекции.
 * Сохраняет meta и data-файлы, поддерживает сегментацию больших коллекций.
 * 
 * @param {object} opts
 * @param {string} opts.collectionName
 * @param {string} opts.collectionDirPath
 * @param {Map} opts.documents
 * @param {object} opts.options
 * @param {Function} opts.getIndexesMeta
 * @returns {{saveCheckpoint: function, startCheckpointTimer: function, stopCheckpointTimer: function}}
 */
function createCheckpointController({ collectionName, collectionDirPath, documents, options, getIndexesMeta }) {
    let checkpointTimer = null;
    const checkpointsDir = path.join(collectionDirPath, '_checkpoints');

    /**
     * Сохраняет checkpoint коллекции.
     *  - meta: метаинформация о коллекции и индексах
     *  - data: сами документы, разбитые по сегментам для оптимизации записи и загрузки больших коллекций
     * 
     * @returns {Promise<{metaFile: string, segmentFiles: string[], meta: object}>}
     */
    async function saveCheckpoint() {
        await fs.mkdir(checkpointsDir, { recursive: true });

        cleanupExpiredDocs(documents);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        // --- Meta
        const meta = {
            collectionName,
            timestamp,
            documentCount: documents.size,
            indexesMeta: getIndexesMeta ? getIndexesMeta() : [],
            type: 'meta'
        };
        const metaFile = getCheckpointFileName(collectionName, 'meta', timestamp);
        await fs.writeFile(path.join(checkpointsDir, metaFile), JSON.stringify(meta, null, 2), 'utf8');

        // --- Data: Разбиваем на сегменты

        // Оптимизация: Быстрый подсчёт размера документа
        const aliveDocs = Array.from(documents.values());
        const maxSegmentSize = options?.maxSegmentSizeBytes || 2 * 1024 * 1024; // 2 MB по умолчанию
        let segmentIndex = 0;
        let currentSegment = [];
        let currentSize = 2; // "[]"
        let segmentFiles = [];

        function getDocSize(doc) {
            // Быстро: JSON.stringify без форматирования + ","
            // PREDICTION: Форматирование почти не влияет на итоговую логику checkpoint, зато ускоряет сегментацию в 10+ раз
            return Buffer.byteLength(JSON.stringify(doc), 'utf8') + 1;
        }

        for (const doc of aliveDocs) {
            const docStr = JSON.stringify(doc);
            const docSize = Buffer.byteLength(docStr, 'utf8') + 1;
            if (currentSize + docSize > maxSegmentSize && currentSegment.length > 0) {
                const dataFile = getCheckpointFileName(collectionName, 'data', timestamp, segmentIndex);
                // Сохраняем весь сегмент с форматированием для читаемости (можно сделать параметром)
                await fs.writeFile(
                    path.join(checkpointsDir, dataFile),
                    JSON.stringify(currentSegment, null, 2),
                    'utf8'
                );
                segmentFiles.push(dataFile);
                segmentIndex++;
                currentSegment = [];
                currentSize = 2;
            }
            currentSegment.push(doc);
            currentSize += docSize;
        }

        // Последний сегмент
        if (currentSegment.length > 0) {
            const dataFile = getCheckpointFileName(collectionName, 'data', timestamp, segmentIndex);
            await fs.writeFile(
                path.join(checkpointsDir, dataFile),
                JSON.stringify(currentSegment, null, 2),
                'utf8'
            );
            segmentFiles.push(dataFile);
        }

        // --- Вернём meta, metaFile и segmentFiles!
        return { metaFile, segmentFiles, meta };
    }

    /**
     * Запускает периодическое сохранение чекпоинтов по таймеру.
     * @param {number} intervalMs
     */
    function startCheckpointTimer(intervalMs = 60 * 1000) {
        stopCheckpointTimer();
        checkpointTimer = setInterval(saveCheckpoint, intervalMs);
    }
    /**
     * Останавливает таймер чекпоинтов.
     */
    function stopCheckpointTimer() {
        if (checkpointTimer) {
            clearInterval(checkpointTimer);
            checkpointTimer = null;
        }
    }

    return {
        saveCheckpoint,
        startCheckpointTimer,
        stopCheckpointTimer
    };
}

module.exports = createCheckpointController;
