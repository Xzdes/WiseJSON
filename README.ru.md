<div align="center">
  <img src="logo.png" width="120" alt="WiseJSON Logo"/>
  <h1>WiseJSON</h1>

  <p>
    <a href="https://github.com/Xzdes/WiseJSON/actions/workflows/main.yml">
      <img src="https://img.shields.io/github/workflow/status/Xzdes/WiseJSON/Node.js%20CI/main" alt="Node.js CI"/>
    </a>
    <a href="https://www.npmjs.com/package/wise-json">
      <img src="https://img.shields.io/npm/v/wise-json" alt="npm"/>
    </a>
    <a href="https://github.com/Xzdes/WiseJSON/blob/main/LICENSE">
      <img src="https://img.shields.io/github/license/Xzdes/WiseJSON" alt="license"/>
    </a>
    <a href="https://www.npmjs.com/package/wise-json">
      <img src="https://img.shields.io/npm/dm/wise-json" alt="Downloads"/>
    </a>
  </p>

  **Лёгкая, встраиваемая JSON-база данных для Node.js. Быстро, надёжно, просто.**  
  _English: [README.md](./README.md)_
</div>

---

## Содержание
- [О проекте](#о-проекте)
- [Возможности](#возможности)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
  - [Node.js](#nodejs)
  - [CLI](#cli)
- [API (Node.js)](#api-nodejs)
- [CLI Команды](#cli-команды)
- [Фильтрация](#фильтрация)
- [Тестирование](#тестирование)
- [Дополнительно](#дополнительно)
- [Дорожная карта](#дорожная-карта)
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
- **TTL (время жизни):** автоматическое удаление устаревших документов  
- **Транзакции** (мульти-коллекция, ACID-подобные)  
- **Graceful shutdown:** сохранение всех данных при завершении или сигнале  
- **CLI:** надёжные фильтры через JSON и JS-предикаты, импорт/экспорт  
- Полный автотестовый раннер  

---

## Установка

```bash
npm install wise-json-db
```

Для глобальной установки CLI:

```bash
npm install -g wise-json-db
```

---

## Быстрый старт

### Node.js

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

### CLI

```bash
wise-json insert users '{"name":"Боб","age":30}'
wise-json find users '{"age":30}'
```

---

## API (Node.js)

Все методы асинхронные (`async`).

| Метод                           | Описание                                          |
| ------------------------------- | ------------------------------------------------- |
| `insert(doc)`                   | Вставить один документ                            |
| `insertMany(docs)`              | Вставить массив документов                        |
| `update(id, updates)`           | Обновить документ по id                           |
| `updateMany(queryFn, updates)`  | Обновить все документы по предикату               |
| `remove(id)`                    | Удалить документ по id                            |
| `clear()`                       | Очистить коллекцию                                |
| `getById(id)`                   | Получить документ по id                           |
| `getAll()`                      | Получить все «живые» документы                    |
| `count()`                       | Количество «живых» документов                     |
| `find(queryFn)`                 | Найти документы по функции-предикату              |

---

## CLI Команды

- `list` — Показать все коллекции  
- `info <collection>` — Статистика и индексы  
- `insert <collection> <json>` — Вставить документ  
- `insert-many <collection> <file.json> [--ttl <ms>]` — Пакетная вставка из файла  
- `find <collection> [filter] [--unsafe-eval]` — Найти документы  
- `get <collection> <id>` — Получить документ по id  
- `remove <collection> <id>` — Удалить документ по id  
- `clear <collection>` — Очистить коллекцию  
- `export <collection> <file.json>` — Экспорт коллекции в файл  
- `import <collection> <file.json>` — Импорт коллекции из файла  

---

## Фильтрация

1. **JSON-фильтр** (безопасно):

   ```bash
   wise-json find users '{"age":30}'
   ```

2. **JS-функция (eval)** — с флагом `--unsafe-eval`:

   ```bash
   wise-json find users 'doc => doc.age > 18' --unsafe-eval
   ```

> ⚠️ **Внимание:** eval разрешён только при явном указании флага.

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

- **TTL:** поля `expireAt` (timestamp в ms) автоматически удаляются.  
- **Graceful Shutdown:** все данные сохраняются при завершении или получении сигнала.  
- **Строгая обработка WAL:** опции в `wal-manager.js` (strict/onError).  
- **Индексы:** поддерживаются уникальные и неуникальные индексы.  
- **Checkpoint:** автоматическое периодическое сохранение.  

---

## Дорожная карта

- [x] Автоматический тестовый раннер  
- [x] Система событий коллекций  
- [ ] Hot backup & restore  
- [ ] Репликация / Синхронизация (в планах)

---

## Лицензия

MIT
