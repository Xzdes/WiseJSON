// wise-json/collection/ttl.js

/**
 * Проверяет, жив ли документ (учитывая expireAt или ttl).
 */
function isAlive(doc) {
    if (!doc || typeof doc !== 'object') return false;
    // Поддержка обоих вариантов поля TTL (expireAt или ttl)
    const exp = doc.expireAt ?? doc.ttl;
    if (!exp) return true;
    const expireTime = typeof exp === 'string' ? Date.parse(exp) : exp;
    return !expireTime || Date.now() < expireTime;
}
exports.isAlive = isAlive;

/**
 * Удаляет все expired-документы из коллекции и обновляет индексы.
 * Возвращает количество удалённых.
 */
function cleanupExpiredDocs(documents, indexManager) {
    let removed = 0;
    for (const [id, doc] of documents.entries()) {
        if (!isAlive(doc)) {
            documents.delete(id);
            if (indexManager) indexManager.afterRemove(doc);
            removed++;
        }
    }
    return removed;
}
exports.cleanupExpiredDocs = cleanupExpiredDocs;
