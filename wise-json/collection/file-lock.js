// wise-json/collection/file-lock.js

const lockfile = require('proper-lockfile');

/**
 * Захватывает file-lock на указанную директорию.
 * @param {string} dirPath
 * @param {object} [options]
 * @returns {Promise<function>} releaseLock функция для снятия lock
 * @throws {Error} если lock не удалось получить
 */
async function acquireCollectionLock(dirPath, options = {}) {
    return lockfile.lock(dirPath, {
        retries: {
            retries: 10,
            factor: 1.5,
            minTimeout: 100,
            maxTimeout: 1000
        },
        stale: 60000,
        ...options
    });
}

/**
 * Снимает file-lock.
 * @param {function} releaseLock
 */
async function releaseCollectionLock(releaseLock) {
    if (releaseLock) {
        try {
            await releaseLock();
        } catch {
            // ignore
        }
    }
}

module.exports = {
    acquireCollectionLock,
    releaseCollectionLock,
};
