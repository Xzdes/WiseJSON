// test/extreme-stress-wise-json.js

const fs = require('fs/promises');
const path = require('path');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const TEST_DB_PATH = path.join(__dirname, 'extreme-stress-db');
const USERS = 10000;
const BATCH = 5000;
const TTL_SEC = 2;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runExtremeTest() {
    console.log('\n🚀 [EXTREME TEST] Старт супернагрузочного теста WiseJSON...\n');
    await fs.rm(TEST_DB_PATH, { recursive: true, force: true }).catch(() => {});

    const db = new WiseJSON(TEST_DB_PATH, { checkpointIntervalMs: 200, walSync: true });
    await db.init();
    const users = await db.collection('users');
    const logs = await db.collection('logs');
    await users.initPromise;
    await logs.initPromise;

    // 1. Массовый insert по одному
    console.time('insert');
    for (let i = 0; i < USERS; ++i) {
        await users.insert({ name: `User${i}`, email: `u${i}@test.com` });
        if (i > 0 && i % 1000 === 0) console.log(`insert: ${i}`);
    }
    console.timeEnd('insert');

    // 2. Batch insert
    console.time('batch');
    const batch = [];
    for (let i = 0; i < BATCH; ++i) {
        batch.push({ name: `Batch${i}`, email: `b${i}@test.com`, testField: i % 2 });
    }
    await users.insertMany(batch);
    console.timeEnd('batch');
    console.log(`Всего пользователей после batch: ${(await users.count())}`);

    // 3. TTL тест: batch с TTL
    const batchTTL = [];
    for (let i = 0; i < 100; ++i) {
        batchTTL.push({ name: `TTL${i}`, email: `ttl${i}@test.com`, expireAt: Date.now() + TTL_SEC * 1000 });
    }
    await users.insertMany(batchTTL);
    console.log('Batch TTL-insert OK');
    await sleep((TTL_SEC + 1) * 1000); // ждём пока истечёт TTL
    const aliveTTL = (await users.find(u => u.name.startsWith('TTL'))).length;
    console.log(`TTL alive: ${aliveTTL}`);
    assert(aliveTTL === 0, 'Некорректно удаляются документы с истёкшим TTL!');

    // 4. Индексы
    await users.createIndex('email', { unique: true });
    await users.createIndex('testField');
    const found = await users.findOneByIndexedValue('email', 'u9999@test.com');
    assert(found, 'Индекс по email не работает');
    console.log('Индексы работают');

    // 5. Update + массовый update
    for (let i = 0; i < 10; ++i) {
        await users.update(found._id, { flag: true });
    }
    const batchIds = (await users.findByIndexedValue('testField', 1)).map(u => u._id);
    for (const id of batchIds.slice(0, 1000)) {
        await users.update(id, { updated: true });
    }
    console.log('Обновления OK');

    // 6. Remove, batch remove
    for (const id of batchIds.slice(0, 100)) {
        await users.remove(id);
    }
    console.log('Удаления OK');

    // 7. Экспорт/импорт
    const allUsers = await users.getAll();
    const exportFile = path.join(TEST_DB_PATH, 'users-export.json');
    await fs.writeFile(exportFile, JSON.stringify(allUsers, null, 2), 'utf8');
    await users.clear();
    const imported = JSON.parse(await fs.readFile(exportFile, 'utf8'));
    await users.insertMany(imported);
    assert((await users.count()) === allUsers.length, 'Импорт/экспорт не совпадает!');
    console.log('Экспорт/импорт OK');

    // 8. Проверка stats
    const stats = await users.stats();
    console.log('Stats:', stats);

    // 9. Логи, вторая коллекция, batch
    for (let i = 0; i < 500; ++i) {
        await logs.insert({ event: 'login', user: `u${i}@test.com` });
    }
    assert((await logs.count()) === 500, 'Логи не пишутся');
    await logs.clear();
    console.log('Коллекция logs работает');

    // 10. Recovery WAL
    await users.insert({ name: 'CRASH_USER', email: 'crash@test.com' });
    await db.close();
    console.log('--- [Crash/recovery] Закрыли первую сессию');

    // Перезапуск
    const db2 = new WiseJSON(TEST_DB_PATH);
    await db2.init();
    const users2 = await db2.collection('users');
    await users2.initPromise;
    const logs2 = await db2.collection('logs');
    await logs2.initPromise;

    // Проверяем, что CRASH_USER есть (восстановление из WAL + индексация)
    const recovered = await users2.findOneByIndexedValue('email', 'crash@test.com');
    assert(recovered, 'Recovery из WAL не сработал!');
    console.log('Recovery WAL OK');

    // Проверка на массовое удаление/очистку
    await users2.clear();
    assert((await users2.count()) === 0, 'Clear не удалил всех!');
    await db2.close();

    console.log('\n✅ EXTREME STRESS TEST PASSED\n');
}

runExtremeTest().catch(e => {
    console.error('\n🔥 [CRITICAL ERROR IN EXTREME TEST]\n', e);
    process.exit(1);
});
