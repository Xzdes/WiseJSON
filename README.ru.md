<div align="center">
  <img src="logo.png" width="120" alt="WiseJSON Logo"/>


# WiseJSON

![Node.js CI](https://img.shields.io/github/workflow/status/Xzdes/WiseJSON/Node.js%20CI/main)
![npm](https://img.shields.io/npm/v/wise-json)
![license](https://img.shields.io/github/license/Xzdes/WiseJSON)
![Downloads](https://img.shields.io/npm/dm/wise-json)

> **Лёгкая, встраиваемая JSON-база данных для Node.js. Быстро, надёжно, просто.**
>
> _English version below:_ [README.md](./README.md)

---

## Оглавление

- [О проекте](#о-проекте)
- [Возможности](#возможности)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [API (Node.js)](#api-nodejs)
  - [Методы коллекции](#методы-коллекции)
  - [Транзакции](#транзакции)
- [CLI](#cli)
- [Тестирование](#тестирование)
- [Дополнительно](#дополнительно)
- [Дорожная карта / Прогресс](#дорожная-карта--прогресс)
- [Лицензия](#лицензия)

---

## О проекте

**WiseJSON** — это лёгкая, быстрая и простая в использовании NoSQL JSON-база для Node.js,  
работающая полностью в виде файлов, без серверов и внешних зависимостей.

- **Готова из коробки:** require — и поехали!
- **Без бинарных зависимостей** (чистый Node.js).
- **Поддерживает:** индексы, транзакции, TTL, checkpoint, WAL, CLI.

---

## Возможности

- Быстрый **CRUD** для JSON-документов
- **Надёжный Write-Ahead Log (WAL)** и checkpoint для устойчивости
- **Индексы** для быстрого поиска
- **TTL (время жизни):** автоматическое протухание документов
- **Транзакции** (мульти-коллекция, ACID-подобные)
- **Graceful shutdown:** все данные сохраняются при завершении или SIGINT/SIGTERM
- **CLI:** мощный и безопасный, фильтры через JSON и JS-предикаты, импорт/экспорт
- **Полный автотестовый раннер** (запуск всех тестов)

---

## Установка

```bash
npm install wise-json
```

Для CLI можно установить глобально:

```bash
npm install -g wise-json
```

---

## Быстрый старт

**Node.js:**

```js
const WiseJSON = require('wise-json');
const db = new WiseJSON('./my-db');

(async () => {
  const users = await db.collection('users');
  await users.insert({ name: 'Алиса', age: 23 });
  const found = await users.find(doc => doc.age > 20);
  console.log(found); // [ { name: 'Алиса', age: 23, ... } ]
})();
```

**CLI:**

```bash
wise-json insert users '{"name":"Боб","age":30}'
wise-json find users '{"age":30}'
```

---

## API (Node.js)

### Методы коллекции

Все методы асинхронные (`async`).

| Метод                                      | Описание                                                   |
| ------------------------------------------- | ---------------------------------------------------------- |
| `insert(doc)`                              | Вставить один документ                                     |
| `insertMany(docs)`                         | Вставить массив документов                                 |
| `update(id, updates)`                      | Обновить документ по id                                    |
| `updateMany(queryFn, updates)`             | Обновить все документы, подходящие под функцию             |
| `remove(id)`                               | Удалить документ по id                                     |
| `clear()`                                  | Очистить коллекцию                                         |
| `getById(id)`                              | Получить документ по id                                    |
| `getAll()`                                 | Получить все "живые" документы                             |
| `count()`                                  | Количество живых документов                                |
| `find(queryFn)`                            | Найти документы по предикату (функции)                     |
| `findOne(queryFn)`                         | Найти один документ по функции                             |
| `createIndex(fieldName, options)`           | Создать индекс по полю (`{unique: true/false}`)            |
| `dropIndex(fieldName)`                      | Удалить индекс по полю                                     |
| `getIndexes()`                             | Получить все индексы                                       |
| `findOneByIndexedValue(field, value)`       | Быстрый поиск одного документа по индексу                  |
| `findByIndexedValue(field, value)`          | Быстрый поиск всех документов по индексу                   |
| `flushToDisk()`                            | Принудительно сохранить checkpoint                         |
| `close()`                                  | Остановить таймеры, сохранить чекпоинт, освободить ресурсы |
| `stats()`                                  | Получить статистику операций                               |
| `on(event, listener)`/`off(event, fn)`     | Подписка/отписка на события коллекции                      |

#### Пример

```js
const users = await db.collection('users');
await users.insert({ name: 'Иван', age: 30 });
await users.createIndex('name', { unique: false });
const ivans = await users.findByIndexedValue('name', 'Иван');
console.log(ivans);
```

---

### Транзакции

Можно выполнять атомарные операции сразу над несколькими коллекциями.

```js
const txn = db.beginTransaction();
await txn.collection('users').insert({ name: 'Боб' });
await txn.collection('logs').insert({ msg: 'Добавлен Боб' });
await txn.commit();
```

- Транзакции либо все применяются, либо нет (atomic).
- В случае ошибки до commit — все изменения откатываются.

---

## CLI

### Справка

```bash
wise-json help
```

### Команды

- `list` — Показать все коллекции
- `info <collection>` — Статистика и индексы
- `insert <collection> <json>` — Вставить документ
- `insert-many <collection> <file.json> [--ttl <ms>]` — Пакетная вставка из файла (опционально TTL)
- `find <collection> [filter] [--unsafe-eval]` — Найти документы (см. ниже)
- `get <collection> <id>` — Получить документ по id
- `remove <collection> <id>` — Удалить документ по id
- `clear <collection>` — Очистить коллекцию
- `export <collection> <file.json>` — Экспорт коллекции в файл
- `import <collection> <file.json>` — Импорт из файла

### Фильтрация

Два варианта фильтрации:
1. **JSON-фильтр** (безопасно):

    ```bash
    wise-json find users '{"age":30}'
    ```

2. **JS-функция (eval)** — с флагом `--unsafe-eval`:

    ```bash
    wise-json find users 'doc => doc.age > 18' --unsafe-eval
    ```

    > ⚠️ **Внимание:** eval разрешён только с флагом для вашей безопасности!

---

## Тестирование

Полный запуск тестов:

```bash
node test/run-all-tests.js
# или
npm test
```

---

## Дополнительно

- **TTL:** Документы с полем `expireAt` (timestamp в ms) автоматически протухают.
- **Graceful Shutdown:** Всё сохраняется при завершении или сигнале.
- **Строгая обработка WAL:** См. `wal-manager.js`, опции strict/onError.
- **Индексы:** Быстрый поиск (уникальные и неуникальные).
- **Checkpoint:** Автоматическое периодическое сохранение.

---

## Дорожная карта / Прогресс

- [x] Корректный graceful shutdown (без дублей)
- [x] Безопасная обработка ошибок WAL (строгий режим/коллбэк)
- [x] CLI: eval только через --unsafe-eval
- [x] Автоматический тестовый раннер
- [x] Система событий коллекций
- [ ] Hot backup & restore
- [ ] Репликация / Синхронизация (планируется)
- [ ] Веб-интерфейс (планируется)

---

## Лицензия

MIT

---

**English version:** [README.md](./README.md)
