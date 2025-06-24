# Введение и Настройка

Добро пожаловать в WiseJSON — встраиваемую JSON‑базу данных для Node.js с поддержкой транзакций, WAL, TTL, индексов и двухсторонней синхронизации.

## Установка

```bash
npm install wise-json-db
```

Это установит пакет `wise-json-db` и все необходимые зависимости (`uuid`, `proper-lockfile` и др.).

## Быстрый старт (Node.js)

```js
// Подключаем библиотеку
const { connect } = require('wise-json-db');

(async () => {
  // Создаём новый экземпляр или открываем существующую БД в директории './data'
  const db = connect('./data', {
    // опции (необязательно):
    //   autocreate: true,    // автосоздание папки
    //   ttlInterval: 60000   // интервал очистки TTL в мс
  });

  // Работа с коллекцией 'users'
  const users = db.collection('users');

  // Вставка одного документа
  await users.insertOne({ id: 1, name: 'Alice' });

  // Вставка нескольких документов
  await users.insertMany([
    { id: 2, name: 'Bob' },
    { id: 3, name: 'Carol' }
  ]);

  // Поиск всех документов
  const all = await users.find({});
  console.log(all);

  // Поиск одного документа
  const alice = await users.findOne({ id: 1 });
  console.log(alice);

  // Обновление одного документа
  await users.updateOne(
    { id: 2 },
    { $set: { name: 'Bobby', active: true } }
  );

  // Удаление документов
  await users.deleteOne(alice._id);
  await users.deleteMany(() => true); // удалить всё

  // Закрыть базу
  await db.close();
})();
```

## Публичный API

```js
const {
  WiseJSON,          // Класс базы (для расширённых сценариев)
  connect,           // Функция-конструктор
  Collection,        // Класс коллекции (альтернативный синхронный способ)
  Document,          // Класс документа (для ручной работы)
  SyncManager,       // Менеджер синхронизации (PUSH/PULL)
  apiClient,         // HTTP-клиент для работы с удалённым сервером
  WALManager,        // Низкоуровневый менеджер журнала WAL
  CheckpointManager, // Менеджер чекпоинтов
  TransactionManager,// Менеджер транзакций
  logger             // Общий логгер
} = require('wise-json-db');
```

### connect(dbPath: string, options?: object) → WiseJSON

* **dbPath** — путь к корневой директории хранения (будет создана, если не существует).
* **options** — необязательные настройки:

  * `autocreate` (boolean) — автосоздание папки.
  * `ttlInterval` (number) — интервал очистки TTL в миллисекундах.
  * `logLevel` (string) — уровень логирования (`info`, `warn`, `error`, `debug`).

Возвращает экземпляр `WiseJSON`, у которого есть:

* `.collection(name: string)` — возвращает экземпляр коллекции.
* `.close()` — завершает работу и снимает все блокировки.

### Collection (аналог MongoDB)

Коллекция поддерживает следующие методы:

| Метод                        | Описание                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `insertOne(doc)`             | Вставить один документ.                                                            |
| `insertMany(docs)`           | Вставить массив документов.                                                        |
| `find(filter)`               | Вернуть массив документов, соответствующих `filter` (объект или функция-предикат). |
| `findOne(filter)`            | Вернуть первый документ, соответствующий фильтру.                                  |
| `updateOne(filter, update)`  | Обновить первый документ по фильтру (поддержка `$set`, `$inc` и др.).              |
| `updateMany(filter, update)` | Обновить все документы по фильтру.                                                 |
| `deleteOne(idOrPredicate)`   | Удалить один документ по `_id` или предикату.                                      |
| `deleteMany(predicate)`      | Удалить все документы, для которых предикат вернёт `true`.                         |

> **Примечание:** `filter` поддерживает как объектный синтаксис (равенство полей), так и функцию-предикат:
>
> ```js
> users.find({ active: true });
> users.find(doc => doc.age > 30);
> ```

### SyncManager и синхронизация

Для двусторонней синхронизации локальных изменений с удалённым сервером:

```js
const sync = new SyncManager(db, {
  interval: 5000,             // интервал синхронизации в мс
  endpoint: 'https://api.example.com',
  auth: { user: 'u', pass: 'p' }
});
sync.start();

// Остановить синхронизацию
sync.stop();
```

`apiClient` позволяет вручную отправлять запросы:

```js
await apiClient.push(db, 'collectionName');
await apiClient.pull(db, 'collectionName');
```

## Дополнительная документация

* **[Коллекции и документы](01-collections-and-documents.md)**
* **[Запросы и индексация](02-querying-and-indexing.md)**
* **[Транзакции](03-transactions.md)**
* **[Продвинутые возможности](04-advanced-features.md)**
* **[Шпаргалка сценариев](05-common-scenarios-cheatsheet.md)**
* **[Устранение неисправностей](06-troubleshooting.md)**
* **[Синхронизация](07-sync.md)**

---

Теперь у вас есть единая точка входа `connect` и полное описание API для Node.js. Приятной разработки!
