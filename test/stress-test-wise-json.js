// WiseJSON Stress Test — нагрузочный автотест функций коллекции
// Run: node stress-test-wise-json.js

const WiseJSON = require('../wise-json/index.js');
const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = './test-stress-db';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runStressTest() {
    // Очищаем тестовую папку перед запуском
    if (fs.existsSync(TEST_DB_PATH)) fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });

    const db = new WiseJSON(TEST_DB_PATH, {
        checkpointIntervalMs: 1000, // Частый чекпоинт
        maxWalEntriesBeforeCheckpoint: 50,
        walForceSync: true,
    });

    const users = await db.collection('users');

    // 1. Проверка insert, insertMany
    let inserted = [];
    for (let i = 0; i < 500; i++) {
        inserted.push(await users.insert({ name: `User${i}`, email: `user${i}@test.com`, counter: i }));
    }
    const batch = [];
    for (let i = 500; i < 1000; i++) {
        batch.push({ name: `User${i}`, email: `user${i}@test.com`, counter: i });
    }
    const batchRes = await users.insertMany(batch);
    if (batchRes.length !== batch.length) throw new Error('insertMany: batch size mismatch');
    console.log('insert/insertMany OK');

    // 2. Проверка индексов и поиска
    await users.createIndex('email', { unique: true });
    const found = await users.findOneByIndexedValue('email', 'user777@test.com');
    if (!found || found.name !== 'User777') throw new Error('Index find error');
    console.log('Indexes OK');

    // 3. Проверка поиска по фильтру и обновлений
    const byFilter = await users.find(doc => doc.counter >= 995);
    if (byFilter.length !== 5) throw new Error('Filter find error');
    for (const doc of byFilter) {
        await users.update(doc._id, { updated: true });
    }
    const updated = await users.find(doc => doc.updated === true);
    if (updated.length !== 5) throw new Error('Update error');
    console.log('Find, update OK');

    // 4. Проверка stats
    const stats = await users.stats();
    if (!stats || typeof stats.inserts !== 'number') throw new Error('Stats error');
    console.log('Stats OK:', stats);

    // 5. Проверка remove и clear
    for (let i = 0; i < 10; i++) {
        await users.remove(inserted[i]._id);
    }
    const countAfterRemove = await users.count();
    if (countAfterRemove !== 990) throw new Error('Remove error');
    await users.clear();
    if ((await users.count()) !== 0) throw new Error('Clear error');
    console.log('Remove, clear OK');

    // 6. Экспорт/импорт
    await users.insert({ name: 'BackupUser', email: 'backup@test.com' });
    const exported = await users.getAll();
    fs.writeFileSync(path.join(TEST_DB_PATH, 'backup.json'), JSON.stringify(exported, null, 2), 'utf8');
    await users.clear();
    const backup = JSON.parse(fs.readFileSync(path.join(TEST_DB_PATH, 'backup.json'), 'utf8'));
    await users.insertMany(backup);
    if ((await users.count()) !== 1) throw new Error('Import error');
    console.log('Export/import OK');

    // 7. Тест WAL/recovery (имитируем crash)
    await users.insert({ name: 'WALUser', email: 'wal@test.com' });
    await db.close();

    // "Crash": Открываем БД заново
    const db2 = new WiseJSON(TEST_DB_PATH);
    const users2 = await db2.collection('users');
    const walUser = await users2.findOneByIndexedValue('email', 'wal@test.com');
    if (!walUser) throw new Error('WAL recovery error');
    await db2.close();
    console.log('WAL/Checkpoint/Recovery OK');

    // Всё прошло!
    console.log('✅ ALL TESTS PASSED');
}

runStressTest().catch(e => {
    console.error('❌ TEST FAILED:', e);
    process.exit(1);
});
