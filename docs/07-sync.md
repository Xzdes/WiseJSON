```markdown
docs/07-sync.md
# 07. Надёжная синхронизация данных и обработка ошибок (WiseJSON Sync)

WiseJSON поддерживает двустороннюю синхронизацию локальных коллекций с удалённым сервером, полностью ориентированную на надёжность, прозрачность событий и диагностику ошибок. Этот раздел — практическое руководство для вашей интеграции.

---

## Зачем это нужно?

- **Локальная работа + резервная синхронизация:** изменения не теряются даже при сбоях сети.
- **Push/Pull модель:** локальные операции отправляются на сервер (PUSH), изменения с сервера применяются локально (PULL).
- **Обработка ошибок по-серьёзному:** все сбои фиксируются не через исключения, а через события (`sync:error` и `sync:success`).

---

## Как это работает?

- **SyncManager** управляет всеми sync-операциями: читает WAL (журнал изменений), отправляет новые записи на сервер, запрашивает изменения с сервера, обновляет коллекцию.
- **Коллекция пробрасывает sync-события наружу:** любой код может реагировать на успешную sync (`sync:success`) или сбой (`sync:error`), не ловя ошибки в promise-цепочках.
- **timestamp-based delta:** только реально новые операции отправляются на сервер.

---

## Базовый пример синхронизации

```js
const WiseJSON = require('wise-json');
const path = require('path');

(async () => {
  // 1. Создаём или открываем базу и коллекцию
  const db = new WiseJSON(path.resolve(__dirname, 'my-sync-db'));
  await db.init();
  const collection = await db.collection('my_docs');
  await collection.initPromise;

  // 2. Навешиваем обработчики событий синхронизации
  collection.on('sync:success', (info) => {
    console.log('[SYNC SUCCESS]', info);
  });
  collection.on('sync:error', (err) => {
    console.error('[SYNC ERROR]', err.message || err);
  });

  // 3. Включаем синхронизацию
  collection.enableSync({
    url: 'https://my-sync-server.example.com',
    apiKey: 'SECRET-API-KEY'
    // (можно передать syncIntervalMs или свой apiClient, если нужно)
  });

  // 4. Работаем как обычно — любые insert/update/remove идут в sync
  await collection.insert({ _id: 'doc1', text: 'Hello world!' });

  // 5. Можно явно запускать синхронизацию вручную
  await collection.triggerSync();

  // ...или ждать авто-синхронизации, если включён syncIntervalMs
})();
````

---

## Как правильно ловить ошибки синхронизации

* **Важный паттерн:**
  Ошибки sync не выбрасываются в await или then, а приходят через событие `sync:error` (это защищает вас от "тихих падений" и неожиданных unhandled promise rejection).
* Пример:

  ```js
  collection.on('sync:error', err => {
    // Можно показать пользователю предупреждение, попробовать перезапустить sync, залогировать ошибку
    console.error('[SYNC ERROR CAUGHT]', err);
  });
  ```

---

## Как устроено под капотом

* **WAL (Write-Ahead Log)** хранит все локальные изменения — ничего не теряется даже при сбое питания.
* **SyncManager** читает WAL, сравнивает timestamps (updatedAt/createdAt), отправляет только новые операции.
* **Коллекция** автоматически применяет все изменения с сервера, а синхронные события `sync:success` и `sync:error` пробрасываются наружу.
* **Ошибки серверной синхронизации** (сетевые сбои, 500-ответы, invalid data) не "роняют" ваш процесс, а поступают как событие, чтобы вы могли реагировать гибко.

---

## Советы по интеграции и диагностике

* Ставьте обработчик на `sync:error` **до** включения sync.
* Всегда обновляйте `apiKey`/`url` при изменении сервера (вызывайте `disableSync()` и затем новый `enableSync()`).
* Для ручной повторной sync после ошибки используйте `collection.triggerSync()`.
* Если хотите полный контроль, используйте свой `apiClient` (см. исходники тестов).

---

## Пример с кастомным API client и ручной обработкой событий

```js
const http = require('http');

function customApiClient() {
  return {
    post: (url, body) => {
      // Пример простой реализации POST-запроса
      return new Promise((resolve, reject) => {
        // ... реализация ...
        resolve({ status: 'ok' }); // для примера
      });
    },
    get: (url) => {
      return Promise.resolve([]); // пример пустого pull
    }
  };
}

const WiseJSON = require('wise-json');
const db = new WiseJSON('./db');
(async () => {
  await db.init();
  const col = await db.collection('sync_demo');
  await col.initPromise;

  col.on('sync:success', payload => console.log('SYNC OK:', payload));
  col.on('sync:error', err => console.error('SYNC FAIL:', err));

  col.enableSync({
    url: 'http://localhost:3000',
    apiKey: 'testkey',
    apiClient: customApiClient()
  });

  // Тестовое изменение
  await col.insert({ _id: 'd1', value: 123 });

  // Форсируем sync для проверки событий
  await col.triggerSync();
})();
```

---

## Рекомендации для продакшена

* Используйте syncIntervalMs для фоновой синхронизации (например, 5000 мс).
* Держите обработчики sync-событий всегда навешанными — для любой диагностики.
* При ошибке sync можно пробовать авто-повтор, алерт или fallback на offline-режим.

---

## Вопросы и ответы

**Q:** Что если sync\:error вообще не ловится?
**A:** Проверьте, что обработчик навешан через collection.on('sync\:error', ...) ДО включения sync, и что ваша коллекция реально пробрасывает события из SyncManager наружу (см. раздел выше).

**Q:** Как проверить, что sync действительно PUSHит и PULLит только новые данные?
**A:** Посмотрите на lastSyncTimestamp: только операции с большим updatedAt/createdAt отправляются на сервер.

---

**WiseJSON делает синхронизацию локальных и серверных коллекций максимально надёжной, диагностируемой и дружелюбной к любым сбоям!**

---

````

---

## Как добавить пример в examples

Создай файл, например, `examples/db-sync-example.js`:

```js
const WiseJSON = require('wise-json');
const path = require('path');

(async () => {
  const db = new WiseJSON(path.resolve(__dirname, 'sync-example-db'));
  await db.init();
  const col = await db.collection('example_sync');
  await col.initPromise;

  col.on('sync:success', info => console.log('SYNC OK', info));
  col.on('sync:error', err => console.error('SYNC ERROR', err));

  col.enableSync({
    url: 'http://localhost:3000',
    apiKey: 'test'
  });

  await col.insert({ _id: 'foo', v: 1 });
  await col.triggerSync();
})();
