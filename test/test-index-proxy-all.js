// test/test-index-proxy.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisejson-proxy-test-'));
  const dbPath = path.join(tmpDir, 'db-dir');
  let db;

  // Гарантированная очистка перед тестом
  if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { recursive: true, force: true });
  }

  try {
    const proxy = require('../index');
    assert.strictEqual(typeof proxy.connect, 'function', 'connect должен быть функцией');

    db = proxy.connect(dbPath);
    // Получаем коллекцию асинхронно, как и положено
    const users = await db.collection('users-proxy-test');
    await users.initPromise;

    // Проверяем наличие НОВЫХ методов
    const methods = [
      'insert', 'insertMany',
      'find', 'findOne',
      'updateOne', 'updateMany',
      'deleteOne', 'deleteMany'
    ];
    methods.forEach(m => {
      assert.strictEqual(typeof users[m], 'function', `Метод ${m} должен существовать`);
    });

    // insert + findOne
    await users.insert({ id: 1, name: 'Alice' });
    const f1 = await users.findOne({ id: 1 });
    assert.strictEqual(f1.name, 'Alice', 'findOne должен найти Alice');

    // insertMany + find
    await users.insertMany([{ id: 2, name: 'Bob' }, { id: 3, name: 'Carol' }]);
    assert.strictEqual(await users.count(), 3, 'После вставки должно быть 3 документа');

    // updateOne
    await users.updateOne({ id: 3 }, { $set: { name: 'Caroline' } });
    const caroline = await users.findOne({ id: 3 });
    assert.strictEqual(caroline.name, 'Caroline', 'updateOne должен обновить имя');

    // deleteOne
    await users.deleteOne({ id: 1 });
    assert.strictEqual(await users.count(), 2, 'После deleteOne должно остаться 2 документа');
    
    // deleteMany
    await users.deleteMany({ id: { $in: [2, 3] } });
    assert.strictEqual(await users.count(), 0, 'После deleteMany должно остаться 0 документов');

    if (typeof db.close === 'function') {
      await db.close();
    }

    console.log('✓ test-index-proxy.js: все проверки пройдены');
    process.exit(0);
  } catch (err) {
    console.error('✗ test-index-proxy.js: ошибка при проверке прокладки', err);
    process.exit(1);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn('Не удалось удалить временные файлы:', cleanupErr);
    }
  }
})();