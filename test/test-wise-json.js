// test/extreme-test-wise-json.js

const fs = require('fs/promises');
const path = require('path');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const TEST_DIR = path.join(__dirname, 'extreme_db');
const COLLECTION_NAME = 'stressTest';

const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function clearDir(dir) {
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch {}
}

async function main() {
    console.log('\n🚀 [EXTREME TEST] Старт стресс-теста WiseJSON...\n');
    await clearDir(TEST_DIR);

    const db = new WiseJSON(TEST_DIR, {
        walForceSync: true,
        checkpointIntervalMs: 0,
        maxWalEntriesBeforeCheckpoint: 0,
        checkpointsToKeep: 2
    });

    const collection = await db.collection(COLLECTION_NAME);

    const COUNT = 1000;
    console.time(`🧪 Вставка ${COUNT} записей с fsync`);
    for (let i = 0; i < COUNT; i++) {
        await collection.insert({
            index: i,
            created: new Date().toISOString(),
            category: i % 10,
            flag: i % 2 === 0,
        });
    }
    console.timeEnd(`🧪 Вставка ${COUNT} записей с fsync`);

    const count = await collection.count();
    assert.strictEqual(count, COUNT, `Должно быть ${COUNT} документов`);

    console.log('✅ Стресс-тест WAL пройден.');

    await db.close();
    console.log('🧯 БД закрыта, стресс-тест завершён.\n');
}

main().catch(err => {
    console.error('🔥 КРИТИЧЕСКАЯ ОШИБКА В EXTREME-ТЕСТЕ 🔥');
    console.error(err);
    process.exit(1);
});
