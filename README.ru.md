# 📦 WiseJSON DB (Мудрая JSON База Данных)

![WiseJSON Логотип](logo.png)

[npm version](https://npmjs.org/package/wise-json-db)  
[License](https://github.com/Xzdes/WiseJSON/blob/master/LICENSE)  
[Node.js CI](https://github.com/Xzdes/WiseJSON/actions/workflows/nodejs.yml)

**WiseJSON DB** — это невероятно быстрая, отказоустойчивая встраиваемая JSON-база данных для Node.js с поддержкой пакетных операций, TTL (время жизни), индексов и сегментированных чекпоинтов. Разработана для высокой производительности, надежности и простоты интеграции в ваши приложения.

---

## 🚀 Ключевые особенности

* **Высокая производительность:** Быстрые операции чтения и записи.
* **Отказоустойчивость:**

  * **WAL (Write-Ahead Logging):** Все изменения сначала записываются в журнал для восстановления данных после сбоев.
  * **Чекпоинты:** Периодическое сохранение состояния базы для быстрого восстановления.
  * **Сегментированные чекпоинты:** Разделение больших коллекций на сегменты.
  * **Атомарная запись файлов:** Безопасная запись JSON через временные файлы.
* **ACID-транзакции:** Поддержка атомарных транзакций между несколькими коллекциями.
* **Индексы:** Уникальные и неуникальные индексы для ускорения поиска.
* **TTL (Time-To-Live):** Автоматическое удаление устаревших документов.
* **Пакетные операции:** Эффективная вставка (`insertMany`) и обновление (`updateMany`).
* **Встраиваемая и файловая:** Хранение данных локально, без отдельного сервера.
* **Простой API:** Интуитивная работа с коллекциями и документами.
* **Инструменты:**

  * **Базовый CLI (`wise-json`):** Для основных операций с БД.
  * **Data Explorer (веб-интерфейс и расширенный CLI `wisejson-explorer`).**
* **Легковесная:** Минимальные зависимости (только `uuid`).
* **Graceful Shutdown:** Корректное сохранение данных при завершении работы приложения.
* **Кастомный генератор ID:** Возможность задать свою функцию генерации `_id`.

---

## 💡 Почему WiseJSON DB?

* **Надежность:** WAL и чекпоинты гарантируют защиту данных даже при сбоях.
* **Скорость:** Индексы и оптимизация ускоряют доступ к данным.
* **Простая интеграция:** Не нужны сторонние сервисы.
* **Полный контроль:** Данные хранятся локально.
* **Гибкость JSON:** Нативное хранение сложных структурированных данных.

---

## 📥 Установка

```bash
npm install wise-json-db
# или
yarn add wise-json-db
```

---

## 📚 Основное использование (API)

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

const dbPath = path.resolve(__dirname, 'myDataBase');

async function main() {
  const db = new WiseJSON(dbPath, {
    ttlCleanupIntervalMs: 60000
  });
  await db.init();

  const users = await db.collection('users');
  await users.initPromise;

  const user1 = await users.insert({ name: 'Alice', age: 30, city: 'New York' });
  console.log('Вставлен пользователь:', user1);

  const userBatch = await users.insertMany([
    { name: 'Bob', age: 24, city: 'London' },
    { name: 'Charlie', age: 35, city: 'Paris', tags: ['dev', 'cat_lover'] }
  ]);
  console.log(`Вставлено ${userBatch.length} пользователей пакетом.`);

  const allUsers = await users.getAll();
  console.log('Все пользователи:', allUsers.length);

  const usersFromLondon = await users.find(user => user.city === 'London');
  console.log('Пользователи из Лондона:', usersFromLondon);

  const devUser = await users.findOne(user => user.tags && user.tags.includes('dev'));
  console.log('Первый разработчик:', devUser);

  if (devUser) {
    const updatedDevUser = await users.update(devUser._id, { age: devUser.age + 1, lastLogin: new Date().toISOString() });
    console.log('Обновленный разработчик:', updatedDevUser);
  }

  const updatedCount = await users.updateMany(
    (user) => user.age > 30,
    { status: 'senior' }
  );
  console.log(`Обновлено ${updatedCount} пользователей (статус senior).`);

  await users.createIndex('city');
  await users.createIndex('name', { unique: true });

  const usersFromParisByIndex = await users.findByIndexedValue('city', 'Paris');
  console.log('Пользователи из Парижа (по индексу):', usersFromParisByIndex);

  const bobByName = await users.findOneByIndexedValue('name', 'Bob');
  console.log('Bob (по уникальному индексу имени):', bobByName);

  console.log('Текущие индексы:', await users.getIndexes());

  const temporaryData = await users.insert({
    message: 'Это сообщение самоуничтожится через 5 секунд',
    expireAt: Date.now() + 5000
  });
  console.log('Вставлены временные данные:', temporaryData._id);

  const txn = db.beginTransaction();
  try {
    const logs = await db.collection('logs');
    await logs.initPromise;

    await txn.collection('users').insert({ name: 'Diana In Txn', age: 28 });
    await txn.collection('logs').insert({ action: 'USER_CREATED', user: 'Diana In Txn', timestamp: Date.now() });
    await txn.commit();
    console.log('Транзакция успешно завершена.');
  } catch (error) {
    await txn.rollback();
    console.error('Ошибка транзакции, изменения отменены:', error);
  }

  console.log('Статистика users:', await users.stats());

  await db.close();
  console.log('База данных закрыта.');
}

main().catch(console.error);
```

---

## 🛠️ Интерфейс командной строки (CLI)

WiseJSON DB включает два CLI:

### 1️⃣ Базовый CLI: `wise-json`

Пример:

```bash
wise-json help
wise-json list
wise-json info <имя_коллекции>
wise-json insert <имя_коллекции> '{"name":"John","age":30}'
wise-json insert-many <имя_коллекции> data.json
wise-json insert-many <имя_коллекции> data.json --ttl 3600000
wise-json find <имя_коллекции> '{"age":30}'
wise-json get <имя_коллекции> <document_id>
wise-json remove <имя_коллекции> <document_id>
wise-json clear <имя_коллекции>
wise-json export <имя_коллекции> export_data.json
wise-json import <имя_коллекции> import_data.json
```

**Переменные окружения:**

* `WISE_JSON_PATH`: Путь к базе данных (по умолчанию `./wise-json-db-data`).
* `WISE_JSON_LANG`: Язык CLI (`ru` или `en`, по умолчанию `en`).

### 2️⃣ Расширенный CLI: `wisejson-explorer`

Пример:

```bash
wisejson-explorer --help
wisejson-explorer list-collections
wisejson-explorer show-collection <имя_коллекции> --limit 5 --offset 0 --sort age --order desc
wisejson-explorer export-collection <имя_коллекции> data.json
wisejson-explorer export-collection <имя_коллекции> data.csv --output csv
wisejson-explorer import-collection <имя_коллекции> data.json --mode replace --allow-write
wisejson-explorer create-index <имя_коллекции> <имя_поля> --unique --allow-write
```

По умолчанию `wisejson-explorer` работает в режиме "только для чтения". Для изменения данных добавляйте `--allow-write`.

---

## 🌐 Data Explorer (веб-интерфейс)

Запуск:

```bash
node explorer/server.js
# или
wisejson-explorer-server
```

По умолчанию: [http://127.0.0.1:3000](http://127.0.0.1:3000).

---

## ⚙️ Конфигурация

```javascript
const db = new WiseJSON('/path/to/db', {
  ttlCleanupIntervalMs: 60000,
  checkpointIntervalMs: 300000,
  maxWalEntriesBeforeCheckpoint: 1000,
  maxSegmentSizeBytes: 2 * 1024 * 1024,
  checkpointsToKeep: 5,
  idGenerator: () => `custom_${Date.now()}`,
  walForceSync: false
});
```

---

## 🔒 Надежность и отказоустойчивость

WiseJSON DB использует WAL и чекпоинты для защиты данных. WAL обеспечивает восстановление после сбоев, а чекпоинты фиксируют состояние базы. Данные записываются атомарно с использованием временных файлов.

---

## 🤝 Вклад в разработку

Будем рады:

* Отчетам об ошибках
* Предложениям по улучшению
* Pull Request'ам

---

## 📄 Лицензия

MIT License. Автор: Xzdes [xzdes@yandex.ru](mailto:xzdes@yandex.ru)