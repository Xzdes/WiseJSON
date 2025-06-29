// explorer/schema-analyzer.js

/**
 * Анализирует одну коллекцию и возвращает информацию о ее полях и индексах.
 * @param {import('../wise-json/collection/core')} collection - Экземпляр коллекции.
 * @returns {Promise<object>}
 */
async function analyzeCollection(collection) {
    const SAMPLE_SIZE = 100; // Анализируем первые 100 документов для определения полей
    const fields = new Map();
    
    // Получаем существующие индексы
    const indexes = await collection.getIndexes();
    const indexedFields = new Map(indexes.map(idx => [idx.fieldName, idx]));

    // Берем выборку документов
    const allDocs = await collection.getAll();
    const sampleDocs = allDocs.slice(0, SAMPLE_SIZE);
    
    for (const doc of sampleDocs) {
        for (const key in doc) {
            if (!fields.has(key)) {
                fields.set(key, { name: key, types: new Set(), isIndexed: false });
            }
            const fieldInfo = fields.get(key);
            
            // Определяем тип данных
            const value = doc[key];
            if (value === null) fieldInfo.types.add('null');
            else if (Array.isArray(value)) fieldInfo.types.add('array');
            else fieldInfo.types.add(typeof value);

            // Проверяем, есть ли индекс
            if (indexedFields.has(key)) {
                fieldInfo.isIndexed = true;
                fieldInfo.isUnique = indexedFields.get(key).type === 'unique';
            }
        }
    }

    // Преобразуем Set в массив для JSON-сериализации
    const finalFields = Array.from(fields.values()).map(f => ({ ...f, types: Array.from(f.types) }));

    return {
        name: collection.name,
        docCount: allDocs.length,
        fields: finalFields,
    };
}

/**
 * Ищет потенциальные связи между коллекциями на основе именования полей.
 * @param {Array<object>} collectionsData - Массив с проанализированными данными коллекций.
 * @returns {Array<object>}
 */
function detectRelationships(collectionsData) {
    const links = [];
    const collectionNames = new Set(collectionsData.map(c => c.name));

    for (const sourceCollection of collectionsData) {
        for (const sourceField of sourceCollection.fields) {
            // Эвристика: ищем поля, заканчивающиеся на 'Id' или '_id', но не являющиеся самим '_id'
            const fieldName = sourceField.name;
            if (fieldName === '_id') continue;

            let potentialTargetName = null;
            if (fieldName.toLowerCase().endsWith('id')) {
                potentialTargetName = fieldName.slice(0, -2);
            } else if (fieldName.toLowerCase().endsWith('_id')) {
                potentialTargetName = fieldName.slice(0, -3);
            }
            
            if (potentialTargetName) {
                // Пытаемся найти коллекцию-цель (например, для 'userId' ищем 'users')
                const targetNameSingular = potentialTargetName;
                const targetNamePlural = `${potentialTargetName}s`; // простое добавление 's'

                if (collectionNames.has(targetNamePlural)) {
                    links.push({
                        source: sourceCollection.name,
                        sourceField: fieldName,
                        target: targetNamePlural,
                        targetField: '_id',
                    });
                } else if (collectionNames.has(targetNameSingular)) {
                     links.push({
                        source: sourceCollection.name,
                        sourceField: fieldName,
                        target: targetNameSingular,
                        targetField: '_id',
                    });
                }
            }
        }
    }
    return links;
}

/**
 * Основная функция. Анализирует всю базу данных и возвращает граф ее структуры.
 * @param {import('../wise-json/index')} db - Экземпляр WiseJSON DB.
 * @returns {Promise<{collections: Array<object>, links: Array<object>}>}
 */
async function analyzeDatabaseGraph(db) {
    const collectionNames = await db.getCollectionNames();
    
    const collectionsData = await Promise.all(
        collectionNames.map(async name => {
            const col = await db.collection(name);
            await col.initPromise;
            return analyzeCollection(col);
        })
    );

    const links = detectRelationships(collectionsData);

    return {
        collections: collectionsData,
        links: links,
    };
}

module.exports = {
    analyzeDatabaseGraph,
};