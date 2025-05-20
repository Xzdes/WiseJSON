# 📦 WiseJSON

> Надёжная, сегментированная и минималистичная embedded JSON-база данных для Node.js.  
> Без зависимостей. Без магии. Только стабильность.

---

## ✨ Особенности

- 🔒 **WAL + Checkpoint** — полная защита от сбоев
- 🧩 **Сегментированное хранение** — масштабируется по мере роста
- 🔁 **Полное восстановление данных** при перезапуске
- 📚 **Индексы** (в т.ч. уникальные) — быстрый поиск и контроль дубликатов
- ⚡ **Fsync по умолчанию** — для отказоустойчивых систем
- 🚫 **Никаких зависимостей** — просто Node.js + CommonJS
- 📦 Совместимость с `pkg` — можно упаковать в бинарник

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

  const user = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  console.log(user._id); // доступ к ID

  const found = await users.findOneByIndexedValue('email', 'alice@example.com');
  console.log(found);

  await db.close(); // обязательно вызывай для сохранения
})();
```

---

## 📁 Структура данных

```plaintext
my-db/
└── users/
    ├── _checkpoints/
    │   ├── checkpoint_meta_users_*.json
    │   └── checkpoint_data_users_*_segN.json
    └── users.wal.jsonl
```

---

## 🧠 Основное API коллекции

| Метод | Описание |
|-------|----------|
| `insert(doc)` | Вставка нового объекта |
| `update(id, data)` | Обновление объекта по ID |
| `remove(id)` | Удаление объекта |
| `getById(id)` | Получение по ID |
| `getAll()` | Все объекты |
| `count()` | Кол-во объектов |
| `clear()` | Очистка коллекции |
| `createIndex(field, {unique})` | Индекс по полю |
| `findOneByIndexedValue(field, value)` | Быстрый поиск по `unique` индексу |
| `findByIndexedValue(field, value)` | Поиск всех по значению |
| `flushToDisk()` | Сохранение чекпоинта |
| `close()` | Закрытие коллекции и БД |

---

## ⚙️ Опции коллекции

| Опция | Значение по умолчанию | Описание |
|-------|------------------------|----------|
| `walForceSync` | `true` | fsync после каждой записи |
| `checkpointIntervalMs` | `300_000` | Период автосохранения (0 = выкл) |
| `maxWalEntriesBeforeCheckpoint` | `1000` | Чекпоинт после N операций |
| `maxSegmentSizeBytes` | `1048576` | Макс. размер сегмента (по байтам) |
| `checkpointsToKeep` | `2` | Кол-во сохраняемых поколений |

---

## 📂 Индексы

```js
await users.createIndex('email', { unique: true });

await users.insert({ name: 'Alice', email: 'alice@example.com' });
await users.insert({ name: 'Bob', email: 'alice@example.com' }); // ❌ Ошибка — дубликат!
```

---

## 🧪 Минимальный тест

```js
const db = new WiseJSON('./db');
const books = await db.collection('books');

await books.insert({ title: '1984', genre: 'sci-fi' });
await books.insert({ title: 'Dune', genre: 'sci-fi' });

const scifi = await books.findByIndexedValue('genre', 'sci-fi');
console.log(scifi.length); // 2

await db.close();
```

---

## 🧯 Защита от сбоев

- **Все операции WAL идут в файл с fsync**
- **Чекпоинты создаются безопасно через .tmp → rename**
- **Восстановление при запуске** — сначала чекпоинт, затем WAL
- **Индексы автоматически пересоздаются**

---

## 📌 Советы по использованию

- Вызови `db.close()` перед завершением процесса
- Используй индексы для часто запрашиваемых полей
- Задай `checkpointsToKeep = 3+` если боишься потери данных
- `flushToDisk()` можно вызывать вручную после батча

---

## 📜 Лицензия

**MIT License**

Copyright (c) 2025 Guliaev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.