const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js'); // путь зависит от структуры

const TEST_DB_PATH = path.resolve(__dirname, 'wise-json-db-test');
const COLLECTION = 'stress_users';

async function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

// Удалить папку базы полностью (sync, чтобы гарантированно)
function removeTestDir() {
    if (fssync.existsSync(TEST_DB_PATH)) {
        fssync.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}

(async function main() {
    console.log('=== WiseJSON FULL STRESS TEST START ===');
    removeTestDir();

    const db = new WiseJSON(TEST_DB_PATH, { ttlCleanupIntervalMs: 5000 });

    // 1. Создание коллекции
    const col = await db.collection(COLLECTION);
    await col.initPromise;

    // 2. Массовая вставка (10_000 документов)
    const docs = [];
    for (let i = 0; i < 10000; ++i) {
        docs.push({
            name: 'User' + i,
            age: Math.floor(Math.random() * 100),
            active: i % 2 === 0,
            _id: 'user_' + i,
            ttl: i % 3 === 0 ? Date.now() + 5000 : undefined // у трети будет TTL 5 сек
        });
    }
    console.time('insertMany');
    await col.insertMany(docs);
    console.timeEnd('insertMany');

    // 3. Проверка количества
    let count = await col.count();
    console.log('Total after insertMany:', count);
    assert(count === 10000, `Expected 10000, got ${count}`);

    // 4. Индекс
    await col.createIndex('age', { unique: false });

    // 5. Поиск по индексу
    const sampleAge = docs[5000].age;
    let found = await col.findByIndexedValue('age', sampleAge);
    console.log(`Documents with age=${sampleAge}:`, found.length);

    // 6. Многопоточные вставки/обновления (Promise.all)
    const updates = [];
    for (let i = 0; i < 1000; ++i) {
        updates.push(col.update('user_' + i, { updatedAt: new Date().toISOString(), value: i * 2 }));
    }
    await Promise.all(updates);
    console.log('Batch update 1000 done.');

    // 7. Удаление части документов
    for (let i = 0; i < 100; ++i) {
        await col.remove('user_' + i);
    }
    console.log('Batch remove 100 done.');

    // 8. Flush to disk + WAL compaction
    await col.flushToDisk();

    // 9. Проверка TTL (протухших)
    console.log('Waiting for TTL (expired docs) to auto-clean...');
    await delay(6000);
    const afterTTL = await col.count();
    console.log('Total after TTL cleanup:', afterTTL);
    assert(afterTTL < 10000, 'TTL cleanup should remove some documents');

    // 10. Checkpoint/восстановление
    await db.close();

    // Новый инстанс — восстановление!
    const db2 = new WiseJSON(TEST_DB_PATH, { ttlCleanupIntervalMs: 5000 });
    const col2 = await db2.collection(COLLECTION);
    await col2.initPromise;
    const restored = await col2.count();
    console.log('Restored from disk:', restored);
    assert(restored === afterTTL, `Expected restored=${afterTTL}, got ${restored}`);

    // Проверка индекса после восстановления
    let foundAfterRestore = await col2.findByIndexedValue('age', sampleAge);
    console.log(`After restore, documents with age=${sampleAge}:`, foundAfterRestore.length);

    // 11. Очистка коллекции
    await col2.clear();
    const empty = await col2.count();
    console.log('After clear:', empty);
    assert(empty === 0, 'Collection should be empty after clear');

    await db2.close();

    removeTestDir();
    console.log('=== WiseJSON FULL STRESS TEST END ===');
    console.log('ALL TESTS PASSED');
})().catch(e => {
    console.error('TEST ERROR:', e);
    process.exit(1);
});
