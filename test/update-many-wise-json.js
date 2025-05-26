const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const TEST_DB_PATH = path.resolve(__dirname, 'wise-json-update-many-test');
const COLLECTION = 'updmany_users';

function removeTestDir() {
    if (fssync.existsSync(TEST_DB_PATH)) {
        fssync.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}

(async function main() {
    console.log('=== WiseJSON UPDATE MANY TEST START ===');
    removeTestDir();
    const db = new WiseJSON(TEST_DB_PATH);

    const col = await db.collection(COLLECTION);
    await col.initPromise;

    // Массовая вставка 1000 пользователей, половина active:true
    const docs = [];
    for (let i = 0; i < 1000; ++i) {
        docs.push({ name: `user${i}`, active: i % 2 === 0, _id: `u${i}` });
    }
    await col.insertMany(docs);

    // Массовое обновление: всем active:true добавляем lastSeen
    const now = Date.now();
    const numUpdated = await col.updateMany(doc => doc.active, { lastSeen: now });

    assert.strictEqual(numUpdated, 500, 'Обновлено должно быть ровно 500 пользователей');

    // Проверить что у всех active:true теперь есть lastSeen
    const all = await col.getAll();
    const withLastSeen = all.filter(d => d.active && d.lastSeen === now);
    assert.strictEqual(withLastSeen.length, 500, 'Ровно 500 пользователей имеют lastSeen');

    // И никто из active:false не обновился
    const wrong = all.filter(d => !d.active && d.lastSeen !== undefined);
    assert.strictEqual(wrong.length, 0, 'Ни один неактивный не должен получить lastSeen');

    await db.close();
    removeTestDir();
    console.log('=== WiseJSON UPDATE MANY TEST END ===');
    console.log('UPDATE MANY TEST PASSED');
})().catch(e => {
    console.error('TEST ERROR:', e);
    process.exit(1);
});
