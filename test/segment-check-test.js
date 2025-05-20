// test/segment-check-test.js

const fs = require('fs/promises');
const path = require('path');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const TEST_DIR = path.join(__dirname, 'segment_test_db');
const COLLECTION_NAME = 'segmentTest';

async function runSegmentTest() {
    console.log('\n📦 [SEGMENT TEST] Проверка сегментного хранения...\n');

    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});

    const db = new WiseJSON(TEST_DIR, {
        maxSegmentSizeBytes: 512, // маленький размер сегмента для принудительной разбивки
        checkpointIntervalMs: 0,
        maxWalEntriesBeforeCheckpoint: 0,
        checkpointsToKeep: 5,
        walForceSync: false,
    });

    const collection = await db.collection(COLLECTION_NAME);

    const totalDocs = 25;
    const baseDoc = {
        type: 'log',
        text: 'a'.repeat(100), // каждый документ ~100+ байт
        timestamp: new Date().toISOString(),
    };

    console.log(`📝 Вставка ${totalDocs} документов...`);
    for (let i = 0; i < totalDocs; i++) {
        await collection.insert({ ...baseDoc, index: i });
    }

    const count = await collection.count();
    assert.strictEqual(count, totalDocs, 'Количество документов должно совпадать');

    console.log('💾 Сохраняем чекпоинт...');
    await collection.flushToDisk();

    const checkpointsPath = path.join(TEST_DIR, COLLECTION_NAME, '_checkpoints');
    const files = await fs.readdir(checkpointsPath);

    const meta = files.filter(f => f.startsWith('checkpoint_meta')).length;
    const segments = files.filter(f => f.startsWith('checkpoint_data')).length;

    console.log(`📁 Найдено файлов: ${files.length}`);
    console.log(`  - Метафайлов: ${meta}`);
    console.log(`  - Сегментов: ${segments}`);
    assert.ok(segments >= 2, 'Должно быть несколько сегментов при малом maxSegmentSizeBytes');

    console.log('📌 Содержимое директории _checkpoints:');
    files.forEach(f => console.log(` - ${f}`));

    await db.close();
    console.log('\n✅ Тест сегментов пройден успешно.\n');
}

runSegmentTest().catch(err => {
    console.error('\n🔥 Ошибка в тесте сегментов!');
    console.error(err);
    process.exit(1);
});
