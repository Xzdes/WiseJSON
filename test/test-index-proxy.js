// test/test-index-proxy.js
// Полный самодостаточный тест для проверки корневого index.js (прокладка).
// Проверяем, что connect возвращает экземпляр, коллекции содержат все Mongo-подобные методы,
// и эти методы работают (insertOne, insertMany, find, findOne, updateOne, updateMany, deleteOne, deleteMany).
// После выполнения теста все временные файлы удаляются.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisejson-test-'));
  const dbPath = path.join(tmpDir, 'db-dir');
  let db;

  try {
    // Подключаемся через прокладку
    const proxy = require('../index');
    assert.strictEqual(typeof proxy.connect, 'function', 'connect должен быть функцией');
    assert.strictEqual(typeof proxy.Collection, 'function', 'Collection должен быть классом');

    // Создаём экземпляр базы
    db = proxy.connect(dbPath, { someOption: true });
    assert.ok(db instanceof proxy.WiseJSON, 'connect должен возвращать WiseJSON');

    // Проверяем наличие sync-менеджера в экспортах
    assert.strictEqual(typeof proxy.SyncManager, 'function', 'SyncManager должен быть функцией/классом');
    assert.strictEqual(typeof proxy.apiClient, 'function', 'apiClient должен быть функцией');

    // Работа с коллекцией
    const users = db.collection('users-proxy-test');

    // Проверяем наличие методов
    const methods = [
      'insertOne','insertMany',
      'find','findOne',
      'updateOne','updateMany',
      'deleteOne','deleteMany'
    ];
    methods.forEach(m => {
      assert.strictEqual(typeof users[m], 'function', `Метод ${m} должен существовать`);
    });

    // insertOne + findOne
    const alice = { id: 1, name: 'Alice' };
    await users.insertOne(alice);
    const f1 = await users.findOne({ id: 1 });
    assert.strictEqual(f1.id, alice.id, 'insertOne/findOne должна вернуть правильный id');
    assert.strictEqual(f1.name, alice.name, 'insertOne/findOne должна вернуть правильное имя');

    // insertMany + find
    const docs = [
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Carol' }
    ];
    await users.insertMany(docs);
    const all = await users.find({});
    assert.strictEqual(Array.isArray(all), true, 'find должна возвращать массив');
    assert.strictEqual(all.length, 3, 'find должна вернуть 3 документа');

    // updateOne + findOne
    await users.updateOne({ id: 2 }, { $set: { name: 'Bobby' } });
    const f2 = await users.findOne({ id: 2 });
    assert.strictEqual(f2.name, 'Bobby', 'updateOne должна обновлять нужный документ');

    // updateMany + find
    await users.updateMany({}, { $set: { active: true } });
    const all2 = await users.find({ active: true });
    assert.strictEqual(all2.length, 3, 'updateMany должна обновить все документы');

    // deleteOne + find by _id
    // Для deleteOne используем _id реального документа
    const toDelete = (await users.find({ id: 3 }))[0];
    await users.deleteOne(toDelete._id);
    const rem1 = await users.find({});
    assert.strictEqual(rem1.length, 2, 'deleteOne должна удалить один документ');

    // deleteMany без фильтра (удаляет все) через predicate true
    await users.deleteMany(() => true);
    const rem2 = await users.find({});
    assert.strictEqual(rem2.length, 0, 'deleteMany должна удалить все документы');

    // Закрываем БД
    if (typeof db.close === 'function') {
      await db.close();
    }

    console.log('✓ test-index-proxy.js: все проверки пройдены');
    process.exit(0);
  } catch (err) {
    console.error('✗ test-index-proxy.js: ошибка при проверке прокладки', err);
    process.exit(1);
  } finally {
    // Удаляем временные файлы и директорию
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn('Не удалось удалить временные файлы:', cleanupErr);
    }
  }
})();
