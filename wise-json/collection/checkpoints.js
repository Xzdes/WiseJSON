const path = require('path');
const fs = require('fs/promises');
const { cleanupExpiredDocs } = require('./ttl.js');

function getCheckpointFileName(collectionName, type, timestamp, segment) {
    if (segment !== undefined) {
        return `checkpoint_${type}_${collectionName}_${timestamp}_seg${segment}.json`;
    }
    return `checkpoint_${type}_${collectionName}_${timestamp}.json`;
}

function createCheckpointController({ collectionName, collectionDirPath, documents, options, getIndexesMeta }) {
    let checkpointTimer = null;
    const checkpointsDir = path.join(collectionDirPath, '_checkpoints');

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
        const aliveDocs = Array.from(documents.values());
        const maxSegmentSize = options?.maxSegmentSizeBytes || 2 * 1024 * 1024; // 2 MB по умолчанию
        let segmentIndex = 0;
        let currentSegment = [];
        let currentSize = 2; // "[]"
        let segmentFiles = [];

        function getDocSize(doc) {
            // Самый надёжный способ — сериализовать
            return Buffer.byteLength(JSON.stringify(doc), 'utf8') + 2; // "," и отступы
        }

        for (const doc of aliveDocs) {
            const docStr = JSON.stringify(doc, null, 2);
            const docSize = Buffer.byteLength(docStr, 'utf8') + 2;
            // Если бы добавление превысило лимит — сохраняем сегмент
            if (currentSize + docSize > maxSegmentSize && currentSegment.length > 0) {
                const dataFile = getCheckpointFileName(collectionName, 'data', timestamp, segmentIndex);
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

    function startCheckpointTimer(intervalMs = 60 * 1000) {
        stopCheckpointTimer();
        checkpointTimer = setInterval(saveCheckpoint, intervalMs);
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
