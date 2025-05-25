<p align="center">
  <img src="./logo.png" alt="WiseJSON Logo" width="150"/>
</p>

<h1 align="center">WiseJSON</h1>
<p align="center">
  <a href="https://github.com/Xzdes/WiseJSON">GitHub</a> • <a href="https://www.npmjs.com/package/wise-json-db">NPM</a>
</p>
<p align="center">
  Безопасная сегментная JSON-база данных для Node.js — минимум зависимостей (<b>uuid</b>), максимум скорости и надёжности.
</p>

---

## ✨ Возможности

- 🔒 **Журнал WAL** + <b>fsync</b> — полная защита от потери данных
- 📦 **Сегментные чекпоинты** — быстрый бэкап и восстановление
- 💡 **Индексы в памяти** (стандартные и уникальные поля)
- ⚡ **Минимум зависимостей** — только [uuid](https://www.npmjs.com/package/uuid)
- 📁 **Встроенная** — не нужен сервер, только папка с файлами
- 🔄 **Пакетная вставка, экспорт/импорт, CLI**
- 🧪 **Стресс- и crash-тесты** — устойчивость к сбоям
- 🪝 **События и хуки** — before/after для всех операций
- 🧮 **Статистика** — по каждой коллекции
- 🧰 **Работает с pkg/vercel/pkg** — удобно в CLI и desktop-приложениях
- 🚀 **Используется в проде** — CLI, микросервисы, боты, локальные приложения

---

## 📦 Зависимость

- [uuid](https://www.npmjs.com/package/uuid) (генерация уникальных id)

---

## 🚀 Быстрый старт

```bash
npm install wise-json-db
```

```js
const WiseJSON = require('wise-json-db');
const db = new WiseJSON('./my-db');

(async () => {
  const users = await db.collection('users');
  await users.createIndex('email', { unique: true });

  const user = await users.insert({ name: 'Алиса', email: 'alice@example.com' });
  console.log('ID пользователя:', user._id);

  const found = await users.findOneByIndexedValue('email', 'alice@example.com');
  console.log('Найдено:', found);

  await db.close();
})();
```

---

## 📁 Структура хранения

```
my-db/
└── users/
    ├── _checkpoints/
    │   ├── checkpoint_meta_users_*.json
    │   └── checkpoint_data_users_*_segN.json
    └── users.wal.jsonl
```

- **WAL** — быстрый лог всех изменений
- **Чекпоинты** — надёжные, разбиты на сегменты

---

## 📘 API коллекции

| Метод                                | Описание                                   |
|-------------------------------------- |--------------------------------------------|
| `insert(doc)`                        | Добавить документ                          |
| `insertMany([docs])`                 | Добавить сразу несколько                   |
| `update(id, updates)`                | Обновить по ID                             |
| `remove(id)`                         | Удалить по ID                              |
| `getById(id)`                        | Получить по ID                             |
| `getAll()`                           | Все документы                              |
| `count()`                            | Количество                                 |
| `clear()`                            | Очистить коллекцию                         |
| `createIndex(field, {unique})`       | Индексировать поле (с уникальностью)       |
| `findOneByIndexedValue(field, value)` | Поиск по уникальному индексу               |
| `findByIndexedValue(field, value)`    | Поиск по стандартному индексу              |
| `find(filter)`                       | Поиск по фильтру (объект или функция)      |
| `stats()`                            | Получить статистику                        |
| `flushToDisk()`                      | Сохранить чекпоинт                         |
| `close()`                            | Сохранить и закрыть                        |
| `on(event, listener)`                | Слушать события                            |

---

## 🪝 События и хуки

Добавьте обработчики для любого действия:

```js
users.on('beforeInsert', doc => {
  doc.createdAt = new Date().toISOString();
});
users.on('afterInsert', doc => {
  console.log('Документ добавлен:', doc._id);
});
```

Поддерживаются:  
- `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeRemove`, `afterRemove`, `beforeClear`, `afterClear`

---

## 🔎 Индексы

```js
await users.createIndex('email', { unique: true });
await users.insert({ name: 'Алиса', email: 'alice@example.com' });
await users.insert({ name: 'Боб', email: 'alice@example.com' }); // Ошибка!
```

---

## ⚙ Конфигурация

| Опция                             | По умолчанию | Описание                                 |
|-----------------------------------|--------------|-------------------------------------------|
| `walForceSync`                    | `true`       | fsync для надёжности                      |
| `checkpointIntervalMs`            | `300000`     | Авточекпоинт раз в N мс (0=выкл)          |
| `maxWalEntriesBeforeCheckpoint`   | `1000`       | Чекпоинт после N операций                 |
| `maxSegmentSizeBytes`             | `1048576`    | Размер сегмента (байт)                    |
| `checkpointsToKeep`               | `2`          | Хранить поколений чекпоинтов              |

---

## 💻 CLI-примеры

CLI поддерживает экспорт/импорт, поиск, очистку, просмотр и др.

```bash
node wise-json/cli/wise-json-cli.js insert users name=Алиса email=alice@example.com
node wise-json/cli/wise-json-cli.js export users > users.json
node wise-json/cli/wise-json-cli.js import users < users.json
node wise-json/cli/wise-json-cli.js find users email alice@example.com
node wise-json/cli/wise-json-cli.js clear users
```

---

## 🔄 Бэкап и восстановление

- Достаточно скопировать папку `my-db/` (со всеми сегментами, WAL и чекпоинтами)
- Для восстановления просто верните файлы на место

---

## 🧪 Тестирование

```bash
node test/extreme-test-wise-json.js
node test/segment-check-test.js
```

---

## 🛡️ Отказоустойчивость

- Надёжный WAL + запись чекпоинта через tmp + rename
- Выдерживает аварийное завершение/сбои питания
- Восстановление: загружается последний чекпоинт, потом все записи из WAL

---

## 🛠️ Для разработчиков

- **JSON only** — все данные открыты для просмотра и резервного копирования
- **Переменная окружения**: `WISEJSON_DB_PATH` — путь к данным
- **Лёгкое расширение** — подключайте свои хуки и расширения

---

## ❓ FAQ

**Q: Готово к продакшену?**  
A: Да! Используется в CLI, автоматизации, ботах, локальных сервисах.

**Q: Можно задавать свой _id?**  
A: Да, или используйте uuid по умолчанию.

**Q: Как очистить коллекцию?**  
A: Метод `clear()` или через CLI.

**Q: Можно хранить файлы/бинарники?**  
A: Не напрямую, но можно хранить метаданные или base64.

---

## 📜 Лицензия

См. файл LICENSE.