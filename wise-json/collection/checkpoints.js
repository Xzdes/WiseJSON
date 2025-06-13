// wise-json/collection/checkpoints.js

const path = require('path');
const fs = require('fs/promises');
const { cleanupExpiredDocs } = require('./ttl.js');
const logger = require('../logger');

/**
 * Генерирует имя файла чекпоинта.
 * Использует timestamp, безопасный для имен файлов (с '-' вместо ':' и '.').
 * @param {string} collectionName
 * @param {string} type - 'meta' или 'data'
 * @param {string} timestampForFileName - Timestamp в формате YYYY-MM-DDTHH-mm-ss-SSSZ
 * @param {number|undefined} segment
 * @returns {string}
 */
function getCheckpointFileName(collectionName, type, timestampForFileName, segment) {
    if (segment !== undefined) {
        return `checkpoint_${type}_${collectionName}_${timestampForFileName}_seg${segment}.json`;
    }
    return `checkpoint_${type}_${collectionName}_${timestampForFileName}.json`;
}

/**
 * Контроллер чекпоинтов для коллекции.
 */
function createCheckpointController({ collectionName, collectionDirPath, documents, options, getIndexesMeta }) {
    let checkpointTimer = null;
    const checkpointsDir = path.join(collectionDirPath, '_checkpoints');

    async function saveCheckpoint() {
        await fs.mkdir(checkpointsDir, { recursive: true });

        if (typeof cleanupExpiredDocs === 'function') {
            cleanupExpiredDocs(documents);
        } else {
            logger.error("[Checkpoints] Функция cleanupExpiredDocs не найдена или не является функцией. Очистка TTL перед чекпоинтом может не произойти.");
        }

        const originalIsoTimestamp = new Date().toISOString(); // Формат: YYYY-MM-DDTHH:MM:SS.sssZ
        const timestampForFileName = originalIsoTimestamp.replace(/[:.]/g, '-'); // Формат: YYYY-MM-DDTHH-mm-ss-SSSZ

        const meta = {
            collectionName,
            timestamp: originalIsoTimestamp, // Оригинальный ISO для хранения в meta
            documentCount: documents.size,
            indexesMeta: getIndexesMeta ? getIndexesMeta() : [],
            type: 'meta'
        };
        
        const metaFile = getCheckpointFileName(collectionName, 'meta', timestampForFileName);
        
        await fs.writeFile(path.join(checkpointsDir, metaFile), JSON.stringify(meta, null, 2), 'utf8');

        const aliveDocs = Array.from(documents.values());
        const maxSegmentSize = options?.maxSegmentSizeBytes || 2 * 1024 * 1024;
        let segmentIndex = 0;
        let currentSegment = [];
        let currentSize = 2; // Учитываем символы "[]" для пустого массива JSON
        let segmentFiles = [];

        for (const doc of aliveDocs) {
            // Для подсчета размера используем строку без форматирования для скорости
            const docJsonString = JSON.stringify(doc); 
            const docSize = Buffer.byteLength(docJsonString, 'utf8') + (currentSegment.length > 0 ? 1 : 0); // +1 за запятую, если не первый элемент
            
            if (currentSize + docSize > maxSegmentSize && currentSegment.length > 0) {
                const dataFile = getCheckpointFileName(collectionName, 'data', timestampForFileName, segmentIndex);
                await fs.writeFile(
                    path.join(checkpointsDir, dataFile),
                    JSON.stringify(currentSegment, null, 2), 
                    'utf8'
                );
                segmentFiles.push(dataFile);
                segmentIndex++;
                currentSegment = [];
                currentSize = 2; // Сбрасываем размер для нового сегмента
            }
            currentSegment.push(doc);
            currentSize += docSize + (currentSegment.length > 1 ? 1 : 0); // +1 за запятую после предыдущего элемента
        }

        if (currentSegment.length > 0) {
            const dataFile = getCheckpointFileName(collectionName, 'data', timestampForFileName, segmentIndex);
            await fs.writeFile(
                path.join(checkpointsDir, dataFile),
                JSON.stringify(currentSegment, null, 2),
                'utf8'
            );
            segmentFiles.push(dataFile);
        }
        
        return { metaFile, segmentFiles, meta }; 
    }

    function startCheckpointTimer(intervalMs) { // Убрал значение по умолчанию, оно должно приходить из опций коллекции
        stopCheckpointTimer();
        if (intervalMs > 0) { 
            checkpointTimer = setInterval(async () => {
                try {
                    // logger.debug(`[Checkpoints] Auto-checkpoint for ${collectionName} triggered by timer.`);
                    await saveCheckpoint();
                } catch (e) {
                    logger.error(`[Checkpoints] Error during auto-checkpoint for ${collectionName}: ${e.message}`, e.stack);
                }
            }, intervalMs);
        }
    }
    
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