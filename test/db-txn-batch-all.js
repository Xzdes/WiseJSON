// test/db-txn-batch-all.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const DB_PATH = path.resolve(__dirname, 'db-txn-batch-all');
const COL = 'txn_test';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { recursive: true, force: true });
}

async function main() {
    console.log('=== DB TXN BATCH ALL TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH);
    const col = await db.collection(COL);
    await col.initPromise;

    // Batch insert
    const batch = [];
    for (let i = 0; i < 100; i++) batch.push({ _id: `k${i}`, v: i });
    await col.insertMany(batch);

    // Batch update
    await col.updateMany(d => d.v % 2 === 0, { even: true });
    const evens = (await col.getAll()).filter(d => d.even);
    assert.strictEqual(evens.length, 50, 'Batch update');

    // Batch remove
    await col.removeMany(d => d.v < 10);
    assert.strictEqual(await col.count(), 90, 'Batch remove');

    // Транзакции: commit и rollback
    const txn = db.beginTransaction();
    await txn.collection(COL).insert({ _id: 'txnX', flag: true });
    await txn.collection(COL).update('k11', { flag: true });
    await txn.commit();
    assert((await col.getById('txnX')).flag, 'Txn insert');
    assert((await col.getById('k11')).flag, 'Txn update');

    const txn2 = db.beginTransaction();
    await txn2.collection(COL).insert({ _id: 'shouldNotExist', flag: 99 });
    await txn2.collection(COL).remove('k12');
    await txn2.rollback();
    assert(!(await col.getById('shouldNotExist')), 'Txn rollback insert');
    assert(await col.getById('k12'), 'Txn rollback remove');

    await db.close();
    cleanUp();

    console.log('=== DB TXN BATCH ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Директория/файлы не были удалены для ручной отладки: ${DB_PATH}`);
    process.exit(1);
});
