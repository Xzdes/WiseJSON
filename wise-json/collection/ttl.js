// wise-json/collection/ttl.js

/**
 * Проверяет, жив ли документ (не истёк ли TTL).
 * @param {Object} doc
 * @returns {boolean}
 */
function isAlive(doc) {
    if (!doc) return false;
    if (!doc.expireAt) return true;
    let expireTime = typeof doc.expireAt === 'string' ? Date.parse(doc.expireAt) : doc.expireAt;
    return Date.now() < expireTime;
}

/**
 * Очищает "протухшие" (expired) документы из коллекции.
 * @param {Map} documents - Map документов (id -> doc)
 * @param {Object} indexManager - IndexManager для обновления индексов при удалении
 * @returns {number} - сколько удалено
 */
function cleanupExpiredDocs(documents, indexManager) {
    let removed = 0;
    for (const [id, doc] of documents.entries()) {
        if (doc && doc.expireAt) {
            let expireTime = typeof doc.expireAt === 'string' ? Date.parse(doc.expireAt) : doc.expireAt;
            if (Date.now() >= expireTime) {
                documents.delete(id);
                if (indexManager && typeof indexManager.afterRemove === 'function') {
                    indexManager.afterRemove(doc);
                }
                removed++;
            }
        }
    }
    return removed;
}

module.exports = {
    isAlive,
    cleanupExpiredDocs
};
