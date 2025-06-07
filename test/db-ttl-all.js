// test/db-ttl-all.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const DB_PATH = path.resolve(__dirname, 'db-ttl-all');
const COL = 'ttl_test';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { recursive: true, force: true });
}

async function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

async function main() {
    console.log('=== DB TTL ALL TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH, { ttlCleanupIntervalMs: 500 });
    const col = await db.collection(COL);
    await col.initPromise;

    // 1. Вставка с TTL = 1 секунда
    await col.insert({ _id: 'a', val: 1, ttl: 1000 }); // 1 секунда
    await col.insert({ _id: 'b', val: 2 }); // без TTL

    assert.strictEqual(await col.count(), 2, 'Count after insert');

    // 2. Ожидаем auto-cleanup
    await sleep(1500);

    // cleanupExpiredDocs уже вызван по таймеру
    assert.strictEqual(await col.count(), 1, 'Count after TTL cleanup');
    const docB = await col.getById('b');
    assert(docB && docB.val === 2, 'Doc b should survive');

    // 3. Массовая вставка с TTL
    const batch = [];
    for (let i = 0; i < 10; i++) batch.push({ _id: `t${i}`, x: i, ttl: 500 });
    await col.insertMany(batch);

    await sleep(700);

    // Проверяем, что все t0-t9 удалены, b остался
    assert.strictEqual(await col.count(), 1, 'All expired batch docs gone, b survives');

    // 4. insert без TTL, вручную вызов cleanup
    await col.insert({ _id: 'c', val: 3 });
    await col.insert({ _id: 'd', val: 4, ttl: 100 });
    await sleep(150);
    // cleanupExpiredDocs можно вызвать явно:
    const { cleanupExpiredDocs } = require('../wise-json/collection/ttl.js');
    cleanupExpiredDocs(col.documents, col._indexManager);

    assert.strictEqual(await col.getById('d'), null, 'd expired and cleaned');
    assert(await col.getById('c'), 'c must stay');

    await db.close();
    cleanUp();

    console.log('=== DB TTL ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Директория/файлы не были удалены для ручной отладки: ${DB_PATH}`);
    process.exit(1);
});
