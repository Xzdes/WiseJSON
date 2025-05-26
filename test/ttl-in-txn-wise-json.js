const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const TEST_DB_PATH = path.resolve(__dirname, 'wise-json-ttl-txn-test');
const COLLECTION = 'ttl_users';

function removeTestDir() {
    if (fssync.existsSync(TEST_DB_PATH)) {
        fssync.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}

(async function main() {
    console.log('=== WiseJSON TTL-IN-TXN TEST START ===');
    removeTestDir();
    const db = new WiseJSON(TEST_DB_PATH, { ttlCleanupIntervalMs: 500 });

    const col = await db.collection(COLLECTION);
    await col.initPromise;

    // Транзакция: вставка с TTL 2 и 5 секунд
    const now = Date.now();
    const txn = db.beginTransaction();
    await txn.collection(COLLECTION).insert({ _id: 'ttl1', data: 'short', ttl: now + 2000 });
    await txn.collection(COLLECTION).insert({ _id: 'ttl2', data: 'long', ttl: now + 5000 });
    await txn.commit();

    assert.strictEqual((await col.count()), 2, 'Должно быть 2 документа');

    // Через 3 секунды останется только второй
    await new Promise(res => setTimeout(res, 3100));
    await col.getAll(); // Форсируем очистку по TTL!
    const after3 = await col.count();
    assert.strictEqual(after3, 1, `Через 3 сек должен остаться 1 документ, а не ${after3}`);

    // Через ещё 3 секунды никого не будет
    await new Promise(res => setTimeout(res, 3100));
    await col.getAll();
    const after6 = await col.count();
    assert.strictEqual(after6, 0, `Через 6 сек никто не должен остаться, а не ${after6}`);

    await db.close();
    removeTestDir();
    console.log('=== WiseJSON TTL-IN-TXN TEST END ===');
    console.log('TTL-IN-TXN TEST PASSED');
})().catch(e => {
    console.error('TEST ERROR:', e);
    process.exit(1);
});
