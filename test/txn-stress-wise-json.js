const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js'); // путь поправь, если надо

const TEST_DB_PATH = path.resolve(__dirname, 'wise-json-txn-test');
const COL_A = 'txn_users';
const COL_B = 'txn_logs';

async function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function removeTestDir() {
    if (fssync.existsSync(TEST_DB_PATH)) {
        fssync.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}

(async function main() {
    console.log('=== WiseJSON TRANSACTION STRESS TEST START ===');
    removeTestDir();

    const db = new WiseJSON(TEST_DB_PATH, { ttlCleanupIntervalMs: 20000 });

    // 1. Коллекции
    const colA = await db.collection(COL_A);
    const colB = await db.collection(COL_B);
    await colA.initPromise;
    await colB.initPromise;

    // 2. Массово (1000 раз) делаем транзакции: вставить пользователя + лог
    console.time('txn_batch');
    for (let i = 0; i < 1000; ++i) {
        const txn = db.beginTransaction();
        await txn.collection(COL_A).insert({ name: `user_${i}`, _id: `u${i}` });
        await txn.collection(COL_B).insert({ action: 'create', user: `u${i}` });
        await txn.commit();
    }
    console.timeEnd('txn_batch');

    // 3. Проверяем: все данные на месте, порядок правильный
    const users = await colA.getAll();
    const logs = await colB.getAll();

    assert.strictEqual(users.length, 1000, 'Все пользователи должны быть на месте');
    assert.strictEqual(logs.length, 1000, 'Все логи должны быть на месте');

    // 4. Имитация сбоя: force close, открываем заново
    await db.close();

    const db2 = new WiseJSON(TEST_DB_PATH, { ttlCleanupIntervalMs: 20000 });
    const colA2 = await db2.collection(COL_A);
    const colB2 = await db2.collection(COL_B);
    await colA2.initPromise;
    await colB2.initPromise;

    const users2 = await colA2.getAll();
    const logs2 = await colB2.getAll();

    assert.strictEqual(users2.length, 1000, 'После рестарта все пользователи должны быть на месте');
    assert.strictEqual(logs2.length, 1000, 'После рестарта все логи должны быть на месте');

    // 5. Параллельно — пачка транзакций (Promise.all)
    const batchTxns = [];
    for (let i = 1000; i < 1100; ++i) {
        const txn = db2.beginTransaction();
        batchTxns.push(
            (async () => {
                await txn.collection(COL_A).insert({ name: `user_${i}`, _id: `u${i}` });
                await txn.collection(COL_B).insert({ action: 'create', user: `u${i}` });
                await txn.commit();
            })()
        );
    }
    await Promise.all(batchTxns);

    const users3 = await colA2.getAll();
    const logs3 = await colB2.getAll();

    assert.strictEqual(users3.length, 1100, 'Параллельные транзакции: все пользователи должны быть на месте');
    assert.strictEqual(logs3.length, 1100, 'Параллельные транзакции: все логи должны быть на месте');

    // 6. Проверяем атомарность: если транзакция не коммитится — ничего не меняется
    const txnFail = db2.beginTransaction();
    await txnFail.collection(COL_A).insert({ name: 'should_not_exist', _id: 'fail1' });
    await txnFail.collection(COL_B).insert({ action: 'fail', user: 'fail1' });
    // Не делаем commit или явно делаем rollback
    await txnFail.rollback();

    const users4 = await colA2.getAll();
    const logs4 = await colB2.getAll();

    assert.strictEqual(users4.length, 1100, 'После rollback не должно добавиться новых пользователей');
    assert.strictEqual(logs4.length, 1100, 'После rollback не должно добавиться новых логов');

    await db2.close();
    removeTestDir();
    console.log('=== WiseJSON TRANSACTION STRESS TEST END ===');
    console.log('ALL TXN TESTS PASSED');
})().catch(e => {
    console.error('TEST ERROR:', e);
    process.exit(1);
});
