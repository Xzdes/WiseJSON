// test/db-unique-index-all.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const DB_PATH = path.resolve(__dirname, 'db-unique-index-all');
const COL = 'uniq_test';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { recursive: true, force: true });
}

async function main() {
    console.log('=== DB UNIQUE INDEX ALL TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH);
    const col = await db.collection(COL);
    await col.initPromise;

    // 1. Создаём уникальный индекс
    await col.createIndex('email', { unique: true });

    // 2. Вставляем первый документ
    await col.insert({ email: 'u1@mail.com', name: 'User1' });
    assert.strictEqual(await col.count(), 1, 'Insert first');

    // 3. Пытаемся вставить второй с таким же email — должно быть исключение!
    let dupError = false;
    try {
        await col.insert({ email: 'u1@mail.com', name: 'User2' });
    } catch (e) {
        dupError = true;
    }
    assert(dupError, 'Duplicate insert throws');

    // 4. Batch insert с одним дубликатом — должна быть ошибка
    let batchError = false;
    try {
        await col.insertMany([
            { email: 'u2@mail.com', name: 'User2' },
            { email: 'u1@mail.com', name: 'User3' }
        ]);
    } catch (e) {
        batchError = true;
    }
    assert(batchError, 'Batch insert with duplicate throws');

    // 5. Batch insert без дубликатов — проходит
    await col.insertMany([
        { email: 'u2@mail.com', name: 'User2' },
        { email: 'u3@mail.com', name: 'User3' }
    ]);
    assert.strictEqual(await col.count(), 3, 'Batch insert OK');

    // 6. Обновление: пытаемся обновить email на уже существующий — ошибка
    let updateError = false;
    try {
        await col.updateMany(d => d.name === 'User3', { email: 'u2@mail.com' });
    } catch (e) {
        updateError = true;
    }
    assert(updateError, 'Update duplicate throws');

    // 7. Обновление без конфликта — проходит
    await col.updateMany(d => d.name === 'User3', { email: 'u4@mail.com' });
    const byEmail = await col.findByIndexedValue('email', 'u4@mail.com');
    assert(byEmail.length === 1 && byEmail[0].name === 'User3', 'Update unique ok');

    await db.close();
    cleanUp();

    console.log('=== DB UNIQUE INDEX ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Директория/файлы не были удалены для ручной отладки: ${DB_PATH}`);
    process.exit(1);
});
