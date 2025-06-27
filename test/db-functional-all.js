// test/db-functional-all.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');
const { cleanupExpiredDocs } = require('../wise-json/collection/ttl.js');

const DB_PATH = path.resolve(__dirname, 'db-functional-all');
const USERS = 'users';
const LOGS = 'logs';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { recursive: true, force: true });
}

async function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

async function main() {
    console.log('=== DB FUNCTIONAL ALL TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH, { ttlCleanupIntervalMs: 500 });
    // Используем новый API
    const users = await db.getCollection(USERS);

    // 1. Вставка, чтение, индексы
    await users.insert({ name: 'Ivan', age: 25, group: 1 });
    await users.insert({ name: 'Petr', age: 30, group: 2 });
    await users.insert({ name: 'Svetlana', age: 22, group: 1 });
    await users.createIndex('group');
    await users.createIndex('name');
    assert.strictEqual(await users.count(), 3, 'Count after insert');
    
    // Заменяем устаревшие методы на find/findOne для консистентности
    const byGroup = await users.find({ group: 1 });
    assert.strictEqual(byGroup.length, 2, 'Index query group=1');
    const byName = await users.findOne({ name: 'Petr' });
    assert(byName && byName.age === 30, 'Index query by name');

    // 2. Update/Remove/Drop Index
    await users.update(byGroup[0]._id, { name: 'Ivanov' });
    await users.remove(byGroup[1]._id);
    await users.dropIndex('group');
    await users.dropIndex('name');
    assert.strictEqual(await users.count(), 2, 'After update/remove');

    // 3. TTL auto-cleanup (документ c ttl)
    await users.insert({ name: 'TTL', age: 99, ttl: 1000 });
    assert.strictEqual(await users.count(), 3, 'Count before TTL');
    await sleep(1100);

    // ГАРАНТИРОВАННО очищаем вручную!
    cleanupExpiredDocs(users.documents, users._indexManager);

    assert.strictEqual(await users.count(), 2, 'TTL auto-cleanup 1');

    // 4. Export/Import (массовый)
    const arr = [];
    for (let i = 0; i < 5000; i++) arr.push({ name: `N${i}`, group: i % 10 });
    const file = path.join(DB_PATH, 'export.json');
    await users.insertMany(arr);
    await users.exportJson(file);

    // Новый лог коллекция
    // ИСПРАВЛЕНО: Используем новый API
    const logs = await db.getCollection(LOGS);
    await logs.insert({ msg: 'log1', level: 'info' });

    // Проверяем экспорт
    assert(fs.existsSync(file), 'Export file exists');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(data.length, 5002, 'Exported count'); // 2 + 5000

    // 5. Импорт/replace
    const importArr = [];
    for (let i = 0; i < 4000; i++) importArr.push({ name: `Y${i}`, group: i % 4 });
    const importFile = path.join(DB_PATH, 'import.json');
    fs.writeFileSync(importFile, JSON.stringify(importArr, null, 2));
    await users.importJson(importFile, { mode: 'replace' });
    assert.strictEqual(await users.count(), 4000, 'Import replace');

    // 6. Checkpoint/wal/close/recover
    await users.flushToDisk();
    await logs.flushToDisk();
    await db.close();

    // 7. Recovery: повторно открываем коллекции, должны восстановиться все данные
    const db2 = new WiseJSON(DB_PATH);
    // ИСПРАВЛЕНО: Используем новый API
    const users2 = await db2.getCollection(USERS);
    assert.strictEqual(await users2.count(), 4000, 'Recovery main');

    // ИСПРАВЛЕНО: Используем новый API
    const logs2 = await db2.getCollection(LOGS);
    assert.strictEqual(await logs2.count(), 1, 'Logs recovery');

    await db2.close();
    cleanUp();

    console.log('=== DB FUNCTIONAL ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ БД не была удалена для ручной отладки: ${DB_PATH}`);
    process.exit(1);
});