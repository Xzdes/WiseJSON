// test/db-unique-index-all.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');
// +++ ИМПОРТ ОШИБКИ +++
const { UniqueConstraintError } = require('../wise-json/errors.js');

const DB_PATH = path.resolve(__dirname, 'db-unique-index-all');
const COL = 'uniq_test';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { recursive: true, force: true });
}

async function main() {
    console.log('=== DB UNIQUE INDEX ALL TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH);
    const col = await db.getCollection(COL);

    // 1. Создаём уникальный индекс
    await col.createIndex('email', { unique: true });

    // 2. Вставляем первый документ
    await col.insert({ email: 'u1@mail.com', name: 'User1' });
    assert.strictEqual(await col.count(), 1, 'Insert first');

    // 3. Пытаемся вставить второй с таким же email — должно быть исключение!
    // ИСПРАВЛЕННЫЙ ТЕСТ:
    await assert.rejects(
        async () => {
            await col.insert({ email: 'u1@mail.com', name: 'User2' });
        },
        UniqueConstraintError,
        'Should throw UniqueConstraintError on duplicate insert'
    );

    // 4. Batch insert с одним дубликатом — должна быть ошибка
    // ИСПРАВЛЕННЫЙ ТЕСТ:
    await assert.rejects(
        async () => {
            await col.insertMany([
                { email: 'u2@mail.com', name: 'User2' },
                { email: 'u1@mail.com', name: 'User3' } // дубликат
            ]);
        },
        UniqueConstraintError,
        'Should throw UniqueConstraintError on batch insert with duplicate'
    );

    // 5. Batch insert без дубликатов — проходит
    await col.insertMany([
        { email: 'u2@mail.com', name: 'User2' },
        { email: 'u3@mail.com', name: 'User3' }
    ]);
    assert.strictEqual(await col.count(), 3, 'Batch insert OK');

    // 6. Обновление: пытаемся обновить email на уже существующий — ошибка
    const user3 = await col.findOne({ email: 'u3@mail.com' });
    // ИСПРАВЛЕННЫЙ ТЕСТ:
    await assert.rejects(
        async () => {
            // Пытаемся установить email 'u2@mail.com', который уже занят
            await col.update(user3._id, { email: 'u2@mail.com' });
        },
        UniqueConstraintError,
        'Should throw UniqueConstraintError on update with duplicate value'
    );

    // 7. Обновление без конфликта — проходит
    await col.update(user3._id, { email: 'u4@mail.com' });
    const byEmail = await col.find({ email: 'u4@mail.com' });
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