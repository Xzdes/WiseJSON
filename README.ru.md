
<div align="center">
  <img src="logo.png" width="100" alt="WiseJSON Logo"/>
  <h1>WiseJSON — Быстрая JSON-база данных для Node.js</h1>
  <a href="https://www.npmjs.com/package/wise-json-db"><img src="https://img.shields.io/npm/v/wise-json-db.svg?style=flat-square" /></a>
  <a href="https://github.com/Xzdes/WiseJSON"><img src="https://img.shields.io/github/stars/Xzdes/WiseJSON?style=flat-square" /></a>
  <br />
  <b>Молниеносная, безопасная и простая embedded JSON-база для Node.js</b>
</div>

---

📖 [English version / Английская версия](./README.en.md)


# WiseJSON — Встраиваемая JSON база для Node.js

WiseJSON — это быстрая, безопасная и простая embedded JSON-база для Node.js. Подходит для кэша, логов, встраиваемых решений и автономных приложений.

---

## 🚀 Особенности

- **Безопасность WAL + чекпоинты** — данные не теряются при сбоях.
- **Массовые вставки** — `insertMany`, `updateMany`.
- **TTL (время жизни)** — автоматическое удаление просроченных документов.
- **Сегментированные чекпоинты** — удобство хранения больших коллекций.
- **Индексы** — уникальные и обычные.
- **Мульти-коллекции** — как в MongoDB, независимые.
- **События** — `on('insert')`, `on('update')`, и т.д.
- **Простой API** — на основе Promise.
- **Полное тестирование** — включая crash recovery.
- **Чистый Node.js** — без нативных модулей.
- **CLI с поддержкой RU/EN**.

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
await users.insert({ name: 'Алиса', email: 'alice@example.com' });
const found = await users.findOneByIndexedValue('email', 'alice@example.com');
console.log(found);
```

---

## 📘 Пример использования API

### Массовая вставка

```js
await users.insertMany([
  { name: 'Боб', email: 'bob@example.com' },
  { name: 'Чарли', email: 'charlie@example.com' }
]);
```

### Индексы

```js
await users.createIndex('email', { unique: true });
const found = await users.findOneByIndexedValue('email', 'bob@example.com');
```

### TTL / Удаление

```js
await users.insert({
  name: 'Ева',
  email: 'eve@example.com',
  expireAt: Date.now() + 1000 * 60 // удалится через 1 минуту
});
```

### Экспорт / Импорт

```js
const data = await users.getAll();
require('fs').writeFileSync('export.json', JSON.stringify(data, null, 2));

const arr = JSON.parse(require('fs').readFileSync('export.json', 'utf8'));
await users.insertMany(arr);
```

---

## 🛠 CLI использование

Примеры:
```bash
wise-json list
wise-json insert users '{"name": "CLI User"}'
wise-json export users out.json
```

Переменные окружения:
- `WISE_JSON_PATH` — путь к базе
- `WISE_JSON_LANG` — `ru` или `en`

---

## 🧪 Тестирование

Запуск:
```bash
node test/extreme-stress-wise-json.js
node test/segment-check-test.js
```

Проверено:
- 5 000 вставок < 300 мс
- WAL восстановление успешно
- TTL и индексы работают

---

## 🧱 Как устроено

- **WAL** — журнал всех операций
- **Чекпоинты** — снимки состояния
- **Сегменты** — нет больших файлов
- **Очередь** — записи последовательно
- **Map в памяти** — активные данные

---

## 🧭 Планы на будущее

- [ ] Сжатие WAL в фоне
- [ ] Проверка схем
- [ ] Режим REPL / CLI автодополнение
- [ ] Веб-интерфейс (Electron)

---

## 📎 Ссылки

- GitHub: https://github.com/Xzdes/WiseJSON
- NPM: https://npmjs.com/package/wise-json-db

Лицензия: MIT

---

## 🧩 Почему WiseJSON?

WiseJSON создан с приоритетом на скорость, надёжность и удобство разработчика.

- **Молниеносные batch-вставки** — до **10 000+** документов за секунды. Batch из 5 000 объектов < **300 мс**.
- **WAL + чекпоинты** — Write-Ahead Log + чекпоинтинг обеспечивают 100% сохранность данных при сбоях.
- **TTL (время жизни)** — Документы автоматически удаляются по `expireAt`. Идеально для логов и кэша.
- **Сегментированные чекпоинты** — Нет лимитов по размеру, можно хранить **миллионы** документов. Всё делится на части.
- **События-хуки** — `beforeInsert`, `afterUpdate`, `onClear` и другие. Удобно для логирования, мониторинга и метрик.
- **Мультиколлекции** — Каждая коллекция независима, со своей структурой, индексами, WAL и чекпоинтами.
- **Индексация** — Ускоряет поиск по полям. Поддерживаются обычные и **уникальные** индексы.
- **Импорт / экспорт / статистика** — Весь набор для работы с коллекциями. `.stats()` — информация по операциям.
- **Удобный API** — `await db.collection('name')` и можно сразу работать. Минимальный и понятный даже новичку.
- **Полное тестирование** — Более **4 000** сценариев: сегментирование, TTL, сбои, индексы.
- **Чистый Node.js** — Без нативных зависимостей, работает везде. Только JavaScript.

---

## 🌟 Достижения

- **Стресс-тестировано**: 15 000 вставок (по одной и batch) за считанные секунды.
- **Batch-вставка**: 5 000 документов менее чем за **300 мс**.
- **Экстремальные сценарии**: WAL, чекпоинты, TTL, экспорт/импорт, индексация и восстановление полностью проверены.
- **Без потерь**: 100% надёжность при сбоях, проверено на crash-симуляциях.
- **Сегментированные чекпоинты**: легко справляются с тысячами документов без проблем с размерами файлов.
- **Кроссплатформенность**: работает на Windows, Linux, Node.js 18 и 20.
- **Открытый проект**: [GitHub/Xzdes/WiseJSON](https://github.com/Xzdes/WiseJSON), [NPM](https://www.npmjs.com/package/wise-json-db)
