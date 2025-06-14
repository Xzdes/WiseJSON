// test/db-queries-all.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');
// ИСПРАВЛЕНИЕ: Путь теперь идет от корня проекта.
// Предполагается, что вы запускаете тесты из корневой папки проекта.
const WiseJSON = require('../wise-json/index.js'); 

const DB_PATH = path.resolve(__dirname, 'db-queries-all');
const COLLECTION_NAME = 'query_tests_col';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
}

async function main() {
    console.log('=== DB QUERIES ALL TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH);
    await db.init();
    const col = await db.collection(COLLECTION_NAME);
    await col.initPromise;

    const testData = [
        { name: 'Alice', age: 30, city: 'New York', tags: ['dev', 'js'], active: true },
        { name: 'Bob', age: 25, city: 'London', tags: ['qa', 'python'], active: false },
        { name: 'Charlie', age: 35, city: 'New York', tags: ['dev', 'go'], active: true },
        { name: 'Diana', age: 30, city: 'Paris', tags: ['pm'], active: true },
        { name: 'Edward', age: 40, city: 'London', tags: ['devops', 'aws'], active: false, salary: 120000 }
    ];

    await col.insertMany(testData);

    console.log('  --- Running tests with function predicates (backwards compatibility) ---');
    let results = await col.find(doc => doc.age === 30);
    assert.strictEqual(results.length, 2, 'Function find: age === 30 should return 2 docs');
    let singleResult = await col.findOne(doc => doc.city === 'Paris');
    assert.strictEqual(singleResult.name, 'Diana', 'Function findOne: city === "Paris" should find Diana');
    console.log('  --- Function predicate tests PASSED ---');


    console.log('  --- Running tests with object filters (new functionality) ---');
    // 1. Простое равенство
    results = await col.find({ city: 'London' });
    assert.strictEqual(results.length, 2, 'Object find: city "London" should return 2 docs');

    // 2. Оператор $gt (больше чем)
    results = await col.find({ age: { '$gt': 30 } });
    assert.strictEqual(results.length, 2, 'Object find: age > 30 should return 2 docs (Charlie, Edward)');
    assert(results.every(d => d.age > 30), 'All found docs should have age > 30');

    // 3. Комбинация операторов ($gte и $lt)
    results = await col.find({ age: { '$gte': 25, '$lt': 35 } });
    assert.strictEqual(results.length, 3, 'Object find: 25 <= age < 35 should return 3 docs (Alice, Bob, Diana)');

    // 4. Оператор $in
    results = await col.find({ city: { '$in': ['Paris', 'London'] } });
    assert.strictEqual(results.length, 3, 'Object find: city in [Paris, London] should return 3 docs');

    // 5. Оператор $exists
    results = await col.find({ salary: { '$exists': true } });
    assert.strictEqual(results.length, 1, 'Object find: salary exists should return 1 doc (Edward)');
    results = await col.find({ salary: { '$exists': false } });
    assert.strictEqual(results.length, 4, 'Object find: salary does not exist should return 4 docs');

    // 6. findOne с объектом
    singleResult = await col.findOne({ name: 'Alice' });
    assert.strictEqual(singleResult.age, 30, 'Object findOne: should find Alice');
    singleResult = await col.findOne({ name: 'Zoe' });
    assert.strictEqual(singleResult, null, 'Object findOne: should return null for non-existent doc');

    // 7. Логический оператор $or
    results = await col.find({ '$or': [{ city: 'Paris' }, { age: 40 }] });
    assert.strictEqual(results.length, 2, 'Object find: $or city is Paris or age is 40 should return 2 docs');
    assert(results.some(d => d.name === 'Diana') && results.some(d => d.name === 'Edward'), '$or result should contain Diana and Edward');

    // 8. Логический оператор $and
    results = await col.find({ '$and': [{ city: 'New York' }, { active: true }] });
    assert.strictEqual(results.length, 2, 'Object find: $and city is New York and active is true should return 2 docs (Alice, Charlie)');

    // 9. Сложный запрос
    results = await col.find({
        age: { '$gte': 30 },
        '$or': [
            { city: 'New York' },
            { tags: { '$in': ['pm'] } }
        ]
    });
    // Должны найтись: Alice (30, NY), Charlie (35, NY), Diana (30, Paris, pm)
    assert.strictEqual(results.length, 3, 'Complex query should return 3 docs');
    console.log('  --- Object filter tests PASSED ---');


    console.log('  --- Running tests for index usage with object filters ---');
    // Создаем индекс по полю, которое будем использовать в запросе
    await col.createIndex('city');
    await col.createIndex('name', { unique: true });

    // Spy на внутренний метод, чтобы проверить, используется ли он
    let findByIdsByIndexCalled = false;
    const originalFindIdsByIndex = col._indexManager.findIdsByIndex;
    col._indexManager.findIdsByIndex = function(...args) {
        findByIdsByIndexCalled = true;
        return originalFindIdsByIndex.apply(this, args);
    };

    // Выполняем запрос на точное равенство по индексированному полю
    results = await col.find({ city: 'New York' });
    assert.strictEqual(results.length, 2, 'Index find: should find 2 docs for New York');
    assert.ok(findByIdsByIndexCalled, 'Index find: findIdsByIndex method should have been called for city query');
    
    // Сбрасываем флаг для следующего теста
    findByIdsByIndexCalled = false;
    
    // Этот запрос не должен использовать индекс 'city', так как есть оператор $in
    results = await col.find({ city: { '$in': ['Paris', 'London'] } });
    assert.strictEqual(findByIdsByIndexCalled, false, 'Index find: index should not be used for $in operator in this simple optimization');

    // Возвращаем оригинальный метод на место
    col._indexManager.findIdsByIndex = originalFindIdsByIndex;

    console.log('  --- Index usage tests PASSED ---');

    await db.close();
    cleanUp();

    console.log('=== DB QUERIES ALL TEST PASSED SUCCESSFULLY ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Тестовая директория не была удалена для отладки: ${DB_PATH}`);
    process.exit(1);
});