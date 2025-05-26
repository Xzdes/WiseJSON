const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const TEST_DB_PATH = path.resolve(__dirname, 'wise-json-batch-test');
const COLLECTION = 'batch_users';

function removeTestDir() {
    if (fssync.existsSync(TEST_DB_PATH)) {
        fssync.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}

(async function main() {
    console.log('=== WiseJSON BATCH UPDATE TEST START ===');
    removeTestDir();
    const db = new WiseJSON(TEST_DB_PATH);

    const col = await db.collection(COLLECTION);
    await col.initPromise;

    // Массовая вставка
    const docs = [];
    for (let i = 0; i < 1000; ++i) {
        docs.push({ name: `user${i}`, active: i % 2 === 0, _id: `u${i}` });
    }
    await col.insertMany(docs);

    // Транзакция: массовое обновление
    const txn = db.beginTransaction();
    for (let i = 0; i < 1000; ++i) {
        await txn.collection(COLLECTION).update(`u${i}`, { updated: true });
    }
    await txn.commit();

    // Проверить все обновления
    const all = await col.getAll();
    for (const doc of all) {
        assert.strictEqual(doc.updated, true, 'Должно быть updated:true');
    }

    await db.close();
    removeTestDir();
    console.log('=== WiseJSON BATCH UPDATE TEST END ===');
    console.log('BATCH UPDATE TEST PASSED');
})().catch(e => {
    console.error('TEST ERROR:', e);
    process.exit(1);
});
