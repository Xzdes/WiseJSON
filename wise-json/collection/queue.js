// wise-json/collection/queue.js

/**
 * Создаёт очередь записи с поддержкой file-lock для коллекции.
 * @param {object} collection - экземпляр Collection
 */
function createWriteQueue(collection) {
    collection._writeQueue = [];
    collection._writing = false;

    /**
     * Добавляет операцию в очередь.
     * @param {Function} opFn - функция-операция
     * @returns {Promise<any>}
     */
    collection._enqueue = function(opFn) {
        return new Promise((resolve, reject) => {
            collection._writeQueue.push({ opFn, resolve, reject });
            collection._processQueue();
        });
    };

    /**
     * Обрабатывает очередь по одной операции.
     * Всегда держит file-lock на время выполнения операции.
     */
    collection._processQueue = async function() {
        if (collection._writing || collection._writeQueue.length === 0) return;
        collection._writing = true;
        const task = collection._writeQueue.shift();
        try {
            await collection._acquireLock();
            const result = await task.opFn();
            task.resolve(result);
        } catch (err) {
            task.reject(err);
        } finally {
            await collection._releaseLockIfHeld();
            collection._writing = false;
            collection._processQueue();
        }
    };
}

module.exports = {
    createWriteQueue,
};
