const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const TEST_DB_PATH = path.resolve(__dirname, 'wise-json-dynidx-test');
const COLLECTION = 'dynidx_users';

function removeTestDir() {
    if (fssync.existsSync(TEST_DB_PATH)) {
        fssync.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}

(async function main() {
    console.log('=== WiseJSON DYNAMIC INDEX TEST START ===');
    removeTestDir();
    const db = new WiseJSON(TEST_DB_PATH);

    const col = await db.collection(COLLECTION);
    await col.initPromise;

    // Вставка документов без индекса
    await col.insertMany([
        { _id: 'a', name: 'A', group: 1 },
        { _id: 'b', name: 'B', group: 2 },
        { _id: 'c', name: 'C', group: 1 },
        { _id: 'd', name: 'D', group: 3 }
    ]);

    // Индекс "на лету"
    await col.createIndex('group', { unique: false });

    // Проверка поиска по индексу
    let found = await col.findByIndexedValue('group', 1);
    assert.strictEqual(found.length, 2, 'Должно быть 2 документа с group=1');
    found = await col.findByIndexedValue('group', 2);
    assert.strictEqual(found.length, 1, 'Должен быть 1 документ с group=2');

    // Индекс можно дропнуть и создать снова
    await col.dropIndex('group');
    await col.createIndex('name', { unique: true });

    // Явная пересборка индекса (если ядро этого требует)
    if (col._indexManager && typeof col._indexManager.rebuildIndexesFromData === 'function') {
        col._indexManager.rebuildIndexesFromData(col.documents);
    }

    found = await col.findByIndexedValue('name', 'C');
    console.log('Docs found by name=C:', found);
    assert.strictEqual(found.length, 1, 'Индекс по name работает');

    await db.close();
    removeTestDir();
    console.log('=== WiseJSON DYNAMIC INDEX TEST END ===');
    console.log('DYNAMIC INDEX TEST PASSED');
})().catch(e => {
    console.error('TEST ERROR:', e);
    process.exit(1);
});
