// collection/checkpoints.js

const path = require('path');
const {
    getCheckpointsPath,
    performCheckpoint,
    cleanupOldCheckpoints,
} = require('../checkpoint-manager.js');

/**
 * Создаёт объект управления чекпоинтами.
 * @param {object} ctx
 * @param {string} ctx.collectionName
 * @param {string} ctx.collectionDirPath
 * @param {Map<string, object>} ctx.documents
 * @param {object} ctx.options
 * @param {function(): Array<object>} ctx.getIndexesMeta
 * @returns {object}
 */
function createCheckpointController(ctx) {
    const {
        collectionName,
        collectionDirPath,
        documents,
        options,
        getIndexesMeta,
    } = ctx;

    const checkpointsDirPath = getCheckpointsPath(collectionDirPath);
    let walOperationCount = 0;
    let checkpointTimer = null;

    const maxWalBeforeCheckpoint = options.maxWalEntriesBeforeCheckpoint ?? 1000;
    const intervalMs = options.checkpointIntervalMs ?? 300_000;
    const checkpointsToKeep = options.checkpointsToKeep ?? 2;

    function startCheckpointTimer() {
        stopCheckpointTimer(); // сбросить старый
        if (intervalMs > 0) {
            checkpointTimer = setTimeout(() => {
                saveCheckpoint().catch(err =>
                    console.error(`[Checkpoint] Ошибка автосохранения: ${err.message}`)
                );
            }, intervalMs);
        }
    }

    function stopCheckpointTimer() {
        if (checkpointTimer) {
            clearTimeout(checkpointTimer);
            checkpointTimer = null;
        }
    }

    async function saveCheckpoint() {
        stopCheckpointTimer(); // перед началом

        const checkpointTs = new Date().toISOString();
        const result = await performCheckpoint(
            checkpointsDirPath,
            collectionName,
            documents,
            checkpointTs,
            options,
            getIndexesMeta()
        );

        walOperationCount = 0;

        await cleanupOldCheckpoints(checkpointsDirPath, collectionName, checkpointsToKeep);

        if (intervalMs > 0) {
            startCheckpointTimer(); // запустить заново
        }

        return result;
    }

    function incrementWalOpsAndMaybeTrigger(opType) {
        if (opType === 'INSERT' || opType === 'UPDATE' || opType === 'REMOVE') {
            walOperationCount += 1;
        } else if (opType === 'CLEAR') {
            walOperationCount = maxWalBeforeCheckpoint; // триггерим сразу
        }

        if (maxWalBeforeCheckpoint > 0 && walOperationCount >= maxWalBeforeCheckpoint) {
            saveCheckpoint().catch(err =>
                console.error(`[Checkpoint] Ошибка при триггере по количеству операций: ${err.message}`)
            );
        }
    }

    return {
        startCheckpointTimer,
        stopCheckpointTimer,
        saveCheckpoint,
        incrementWalOpsAndMaybeTrigger,
    };
}

module.exports = createCheckpointController;
