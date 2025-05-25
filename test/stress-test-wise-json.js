// test/stress-test-wise-json.js

const fs = require('fs/promises');
const path = require('path');
const WiseJSON = require('../wise-json/index.js');

const TEST_DB_PATH = path.join(__dirname, 'test-stress-db');

async function runStressTest() {
    await fs.rm(TEST_DB_PATH, { recursive: true, force: true }).catch(() => {});
    const db = new WiseJSON(TEST_DB_PATH, { checkpointIntervalMs: 250, walSync: true });
    await db.init();
    const users = await db.collection('users');
    await users.initPromise;

    // 1. insert/insertMany
    for (let i = 0; i < 500; ++i) {
        await users.insert({ name: `User${i}`, email: `u${i}@test.com` });
    }
    const batch = [];
    for (let i = 500; i < 1000; ++i) {
        batch.push({ name: `User${i}`, email: `u${i}@test.com` });
    }
    await users.insertMany(batch);
    console.log('insert/insertMany OK');

    // 2. Indexes
    await users.createIndex('email', { unique: true });
    const found = await users.findOneByIndexedValue('email', 'u999@test.com');
    if (!found) throw new Error('Index test failed');
    console.log('Indexes OK');

    // 3. Find, update
    const fnd = await users.find(u => u.email.endsWith('@test.com'));
    if (fnd.length < 1000) throw new Error('Find test failed');
    for (let i = 0; i < 5; ++i) {
        await users.update(fnd[i]._id, { updated: true });
    }
    console.log('Find, update OK');

    // 4. Stats
    const stats = await users.stats();
    console.log('Stats OK:', stats);

    // 5. Remove, clear
    for (let i = 0; i < 10; ++i) {
        await users.remove(`User${i}`); // (Будет false, если id — не name, игнорим)
    }
    await users.clear();
    const afterClear = await users.getAll();
    if (afterClear.length !== 0) throw new Error('Clear test failed');
    console.log('Remove, clear OK');

    // 6. Export/import
    await users.insertMany([{ name: "import1", email: "import1@test.com" }, { name: "import2", email: "import2@test.com" }]);
    const exportFile = path.join(TEST_DB_PATH, 'users-export.json');
    await fs.writeFile(exportFile, JSON.stringify(await users.getAll(), null, 2), 'utf8');
    await users.clear();
    const importData = JSON.parse(await fs.readFile(exportFile, 'utf8'));
    await users.insertMany(importData);
    const afterImport = await users.getAll();
    if (afterImport.length < 2) throw new Error('import/export failed');
    console.log('Export/import OK');

    // 7. WAL/Checkpoint/Recovery test с логами
    await users.insert({ name: 'WALUser', email: 'wal@test.com' });
    await db.close();

    // Проверим содержимое директории
    console.log('--- Before recovery ---');
    const checkpointDir = path.join(TEST_DB_PATH, 'users', '_checkpoints');
    try {
        const files = await fs.readdir(checkpointDir);
        console.log('Checkpoints:', files);
    } catch (e) {
        console.log('No checkpoint dir:', e.message);
    }
    const walPath = path.join(TEST_DB_PATH, 'users', 'users.wal');
    try {
        const walData = await fs.readFile(walPath, 'utf8');
        console.log('WAL contents:', walData.trim().split('\n').slice(-5)); // последние 5 строк
    } catch (e) {
        console.log('No WAL file:', e.message);
    }

    // "Crash": Открываем БД заново
    const db2 = new WiseJSON(TEST_DB_PATH);
    await db2.init();
    const users2 = await db2.collection('users');
    await users2.initPromise;

    // Логируем всё после восстановления
    const allDocs = await users2.getAll();
    console.log('Recovered docs:', allDocs.map(u => ({ _id: u._id, email: u.email })));

    const emails = allDocs.map(u => u.email);
    const walUser = await users2.findOneByIndexedValue('email', 'wal@test.com');
    console.log('Recovery by index:', !!walUser, walUser);

    if (!walUser) throw new Error('WAL recovery error');

    await db2.close();
    console.log('WAL/Checkpoint/Recovery OK');
    console.log('✅ ALL TESTS PASSED');
}

runStressTest().catch(e => {
    console.error('❌ TEST FAILED:', e);
    process.exit(1);
});
