// wise-json/collection/ttl.js

/**
 * Проверяет, жив ли документ (учитывая expireAt или ttl).
 * ttl — это время жизни в ms с момента createdAt.
 * expireAt — абсолютная дата (ms или ISO string).
 */
function isAlive(doc) {
    if (!doc || typeof doc !== 'object') {
        return false;
    }

    // Абсолютный срок жизни (expireAt)
    if (doc.hasOwnProperty('expireAt')) { // Используем hasOwnProperty для явного указания на поле
        if (doc.expireAt === null || doc.expireAt === undefined) {
            // Если expireAt явно null или undefined, считаем его бессрочным по этому критерию
            // (или можно интерпретировать как ошибку, но для isAlive лучше вернуть true)
        } else {
            const exp = typeof doc.expireAt === 'string'
                ? Date.parse(doc.expireAt)
                : Number(doc.expireAt);

            if (isNaN(exp)) {
                // Если expireAt не может быть преобразован в валидную дату (например, "not-a-date"),
                // считаем такой документ "живым", чтобы избежать случайного удаления из-за неверных данных.
                // Администратор должен будет исправить такие данные вручную.
                return true;
            }
            // Если exp - валидное число, проверяем, не истек ли срок
            return Date.now() < exp;
        }
    }

    // TTL — относительный срок жизни (ms от createdAt)
    if (doc.hasOwnProperty('ttl')) { // Используем hasOwnProperty
        if (doc.ttl === null || doc.ttl === undefined) {
            // Если ttl явно null или undefined, этот критерий не применяется
        } else {
            const createdAtStr = doc.createdAt;
            if (!createdAtStr) {
                // Если нет createdAt, а ttl задан, невозможно рассчитать срок жизни.
                // Считаем "живым", чтобы не удалить по ошибке.
                return true;
            }

            const createdAtMs = Date.parse(createdAtStr);
            if (isNaN(createdAtMs)) {
                // Если createdAt невалиден, невозможно рассчитать срок жизни.
                // Считаем "живым".
                return true;
            }

            const ttlMs = Number(doc.ttl);
            if (isNaN(ttlMs)) {
                // Если ttl не число, невозможно рассчитать. Считаем "живым".
                return true;
            }

            // Date.now() должен быть строго меньше, чем createdAtMs + ttlMs
            // Если ttlMs равен 0, то Date.now() < createdAtMs будет false (или true, если часы сильно рассинхронизированы),
            // что корректно сделает документ "неживым" практически сразу.
            return Date.now() < (createdAtMs + ttlMs);
        }
    }

    // Если нет ни expireAt, ни ttl, документ считается бессрочным (живым)
    return true;
}
exports.isAlive = isAlive;

/**
 * Удаляет все expired-документы из Map документов и обновляет индексы, если indexManager предоставлен.
 * Возвращает количество удалённых документов.
 * @param {Map<string, object>} documents - Карта документов коллекции.
 * @param {object} [indexManager] - Опциональный менеджер индексов для обновления.
 * @returns {number} - Количество удаленных документов.
 */
function cleanupExpiredDocs(documents, indexManager) {
    let removedCount = 0;
    if (!(documents instanceof Map)) {
        // console.warn('[TTL Cleanup] Provided documents is not a Map. Skipping cleanup.');
        return removedCount; // Защита, если передан не Map
    }

    const idsToRemove = [];
    for (const [id, doc] of documents.entries()) {
        if (!isAlive(doc)) {
            idsToRemove.push(id);
        }
    }

    if (idsToRemove.length > 0) {
        for (const id of idsToRemove) {
            const docToRemove = documents.get(id); // Получаем документ перед удалением для indexManager
            if (docToRemove) { // Убедимся, что он все еще там (маловероятно, но для безопасности)
                documents.delete(id);
                if (indexManager && typeof indexManager.afterRemove === 'function') {
                    indexManager.afterRemove(docToRemove);
                }
                removedCount++;
            }
        }
    }
    return removedCount;
}
exports.cleanupExpiredDocs = cleanupExpiredDocs;