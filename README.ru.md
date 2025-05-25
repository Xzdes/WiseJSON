
<div align="center">
  <img src="logo.png" width="100" alt="WiseJSON Logo"/>
  <h1>WiseJSON — Быстрая JSON база для Node.js</h1>
  <a href="https://www.npmjs.com/package/wise-json-db"><img src="https://img.shields.io/npm/v/wise-json-db.svg?style=flat-square" /></a>
  <a href="https://github.com/Xzdes/WiseJSON"><img src="https://img.shields.io/github/stars/Xzdes/WiseJSON?style=flat-square" /></a>
  <br />
  <b>Молниеносная, отказоустойчивая и простая embedded JSON-база для Node.js</b>
</div>

---

## 🚀 Особенности

- **Молниеносный batch:** до 10 000+ вставок за секунды, batch-вставка 5 000 за 300 мс.
- **Безопасность через WAL + чекпоинты:** после сбоя данные и индексы полностью восстанавливаются.
- **Нативная поддержка batch, TTL/expire:** массовые вставки, обновления, автоматическое удаление устаревших документов.
- **Сегментированные чекпоинты:** нет ограничений по размеру, можно хранить миллионы документов.
- **Хуки событий:** before/after для расширенной логики.
- **Несколько коллекций, индексы, экспорт/импорт, статистика, удобный API.**
- **Только Node.js и [uuid](https://www.npmjs.com/package/uuid).**
- **Кроссплатформенность и высокая надёжность.**
- **Протестировано в самых жёстких условиях.**

---

## 🌟 Достижения

- **Экстремальные тесты:** 15 000 вставок (по одной + batch) за несколько секунд.
- **Batch из 5 000 объектов** — менее чем за 300 мс.
- **Экспорт/импорт коллекций с тысячами объектов.**
- **100% восстановление данных после "аварии" (recovery).**
- **Нет потерь данных, сегментированные чекпоинты, индексы всегда в актуальном состоянии.**
- [GitHub/Xzdes/WiseJSON](https://github.com/Xzdes/WiseJSON) | [NPM/wise-json-db](https://www.npmjs.com/package/wise-json-db)

---

## 📦 Установка

```bash
npm install wise-json-db uuid
```

---

## 🔥 Быстрый старт

```js
const WiseJSON = require('wise-json-db');
const db = new WiseJSON('./my-db-folder', { checkpointIntervalMs: 500 });
await db.init();

const users = await db.collection('users');
await users.insert({ name: 'Алиса', email: 'alice@domain.com' });
const found = await users.findOneByIndexedValue('email', 'alice@domain.com');
console.log(found);
```

---

## 📘 Полные примеры использования

### Batch вставка

```js
await users.insertMany([
  { name: 'Боб', email: 'bob@domain.com' },
  { name: 'Чарли', email: 'charlie@domain.com' }
]);
```

### Индексы

```js
await users.createIndex('email', { unique: true });
const user = await users.findOneByIndexedValue('email', 'bob@domain.com');
```

### TTL/expire

```js
await users.insert({
  name: 'Ева',
  email: 'eve@domain.com',
  expireAt: Date.now() + 1000 * 60 // удалится через 1 минуту
});
```

### Экспорт/импорт

```js
const data = await users.getAll();
require('fs').writeFileSync('users-export.json', JSON.stringify(data, null, 2));
// Импорт
const arr = JSON.parse(require('fs').readFileSync('users-export.json', 'utf8'));
await users.insertMany(arr);
```

---

## 🧪 Тестирование и результаты

Все тесты (easy, stress, extreme, segment, WAL recovery, TTL, batch, экспорт/импорт, crash recovery, мультиколлекции) **успешно пройдены**:

- `node test/easy-test-wise-json.js`
- `node test/stress-test-wise-json.js`
- `node test/extreme-stress-wise-json.js`
- `node test/segment-check-test.js`

Результаты:
- **10 000 вставок:** ~2.5 сек
- **5 000 batch-вставок:** ~300 мс
- **Восстановление WAL + чекпоинт:** всегда успешно
- **Нет потерь данных даже под высокой нагрузкой**

---

## 📖 Документация

Полная документация на GitHub: [https://github.com/Xzdes/WiseJSON](https://github.com/Xzdes/WiseJSON#api)

---

## 🛠 Требования

- Node.js 18 или выше
- Зависимость: [uuid](https://www.npmjs.com/package/uuid)

---

## 📎 Ссылки

- **GitHub:** [https://github.com/Xzdes/WiseJSON](https://github.com/Xzdes/WiseJSON)
- **NPM:** [https://www.npmjs.com/package/wise-json-db](https://www.npmjs.com/package/wise-json-db)
- [Документация и баг-репорты](https://github.com/Xzdes/WiseJSON)
- Лицензия: MIT

---

**WiseJSON — лёгкая, быстрая и надёжная embedded база для ваших проектов.**

---
