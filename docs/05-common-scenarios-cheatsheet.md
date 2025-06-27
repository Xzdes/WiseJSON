```markdown
# 05 - Распространенные Сценарии и Шпаргалка

Этот раздел содержит готовые примеры кода для решения типичных задач с помощью WiseJSON DB, а также краткую и актуальную шпаргалку по основным операциям. Эти сценарии помогут вам быстро интегрировать базу данных в ваши проекты.

## Сценарий 1: Хранилище Пользовательских Профилей

**Задача:** Создать простое хранилище для профилей пользователей с уникальным email, возможностью поиска, добавления и обновления информации.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function userProfileManagement() {
  const dbPath = path.resolve(__dirname, 'userProfilesDb');
  let db;

  try {
    db = new WiseJSON(dbPath);
    await db.init();
    console.log('База данных профилей инициализирована.');

    const profiles = await db.collection('profiles');
    await profiles.initPromise;
    await profiles.clear(); // Очистим для чистоты примера

    // Создадим уникальный индекс по email для быстрого поиска и предотвращения дубликатов
    await profiles.createIndex('email', { unique: true });
    console.log('Уникальный индекс по "email" создан.');

    // Добавление новых профилей
    await profiles.insertMany([
      { name: 'Елена Смирнова', email: 'elena@example.com', age: 28, city: 'Москва' },
      { name: 'Алексей Иванов', email: 'alex@example.com', age: 34, city: 'Санкт-Петербург' }
    ]);
    console.log('Профили добавлены.');

    // Попытка добавить пользователя с существующим email (вызовет ошибку)
    try {
      await profiles.insert({ name: 'Другая Елена', email: 'elena@example.com', age: 30 });
    } catch (e) {
      console.log(`\nОжидаемая ошибка: ${e.message}`); // Сообщение о нарушении уникальности
    }

    // Поиск профиля по email (автоматически использует индекс)
    console.log('\nИщем профиль Алексея по email...');
    const foundAlex = await profiles.findOne({ email: 'alex@example.com' });
    if (foundAlex) {
      console.log('Найден профиль:', foundAlex);

      // Обновление информации в профиле Алексея
      console.log('\nОбновляем возраст и город Алексея...');
      const updatedAlex = await profiles.update(foundAlex._id, { age: 35, city: 'Новосибирск' });
      console.log('Обновленный профиль Алексея:', updatedAlex);
    }

    // Получение всех профилей
    console.log('\nВсе профили в базе:');
    const allProfiles = await profiles.getAll();
    allProfiles.forEach(p => console.log(`- ${p.name}, email: ${p.email}, возраст: ${p.age}`));

  } catch (error) {
    console.error('Ошибка в сценарии управления профилями:', error);
  } finally {
    if (db) await db.close();
  }
}

userProfileManagement();
```

## Сценарий 2: Логирование Событий с Автоудалением (TTL)

**Задача:** Записывать события приложения в коллекцию логов. Старые или временные логи должны автоматически удаляться через заданное время.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function eventLoggingWithTTL() {
  const dbPath = path.resolve(__dirname, 'eventLogsDb');
  // Настроим частую проверку TTL для демонстрации (каждые 3 секунды)
  const db = new WiseJSON(dbPath, { ttlCleanupIntervalMs: 3000 });
  await db.init();
  
  const eventLogs = await db.collection('event_logs');
  await eventLogs.initPromise;
  await eventLogs.clear();

  console.log('Записываем события...');
  await eventLogs.insert({
    level: 'INFO',
    message: 'Приложение запущено.',
    ttl: 7 * 24 * 60 * 60 * 1000 // Этот лог будет жить 7 дней
  });
  await eventLogs.insert({
    level: 'DEBUG',
    message: 'Отладочное сообщение, исчезнет через 5 секунд.',
    ttl: 5000 // 5 секунд
  });

  console.log(`\nТекущее количество логов: ${await eventLogs.count()}`); // Ожидаем 2

  console.log('Ожидаем 6 секунд, чтобы отладочный лог истек...');
  await new Promise(resolve => setTimeout(resolve, 6000));

  // TTL очистка произойдет либо по таймеру, либо при следующем чтении (например, count).
  const countAfterTTL = await eventLogs.count();
  console.log(`Количество логов после ожидания: ${countAfterTTL}`); // Ожидаем 1

  await db.close();
}

eventLoggingWithTTL();
```

## Сценарий 3: Атомарная Регистрация (Транзакция)

**Задача:** При регистрации нового пользователя необходимо создать запись о нем в коллекции `users` и одновременно создать запись о его начальном балансе в коллекции `balances`. Обе операции должны либо выполниться успешно, либо не выполниться вовсе.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // Для генерации ID

async function userRegistrationWithBalance() {
  const dbPath = path.resolve(__dirname, 'registrationDb');
  const db = new WiseJSON(dbPath);
  await db.init();

  const users = await db.collection('users_reg');
  await users.initPromise;
  const balances = await db.collection('balances_reg');
  await balances.initPromise;
  await users.clear();
  await balances.clear();

  // Генерируем ID пользователя заранее, так как он нужен для обеих операций
  const newUserId = uuidv4();

  const txn = db.beginTransaction();
  console.log(`\nНачинаем транзакцию для регистрации пользователя ${newUserId}...`);

  try {
    const txnUsers = txn.collection('users_reg');
    const txnBalances = txn.collection('balances_reg');

    // Операция 1: Создание пользователя
    await txnUsers.insert({
      _id: newUserId,
      name: 'Новый Пользователь',
      email: 'newuser@example.com'
    });

    // Операция 2: Создание начального баланса
    await txnBalances.insert({
      userId: newUserId,
      currency: 'RUB',
      amount: 0
    });

    console.log('Применяем транзакцию (commit)...');
    await txn.commit();
    console.log('Транзакция регистрации успешно применена.');

  } catch (transactionError) {
    console.error('Ошибка в транзакции, откатываем:', transactionError.message);
    await txn.rollback();
  }

  // Проверяем, что обе записи были созданы
  const registeredUser = await users.getById(newUserId);
  const userBalance = await balances.findOne({ userId: newUserId });
  console.log('\nПользователь создан:', !!registeredUser);
  console.log('Баланс создан:', !!userBalance);
  
  await db.close();
}

userRegistrationWithBalance();
```

## Шпаргалка (Cheatsheet) по Основным Операциям

| Задача                                        | Метод API / Пример Кода                                                               |
| :-------------------------------------------- | :------------------------------------------------------------------------------------ |
| **Инициализация**                             |                                                                                       |
| Подключить библиотеку                         | `const WiseJSON = require('wise-json-db');`                                           |
| Создать и инициализировать БД                 | `const db = new WiseJSON('path/to/db'); await db.init();`                              |
| Получить/создать и инициализировать коллекцию | `const col = await db.collection('name'); await col.initPromise;`                      |
| Закрыть БД (сохранить всё)                    | `await db.close();`                                                                   |
| **Документы - Создание (Create)**             |                                                                                       |
| Вставить один документ                        | `await col.insert({ name: 'A', value: 1 });`                                          |
| Вставить массив документов                    | `await col.insertMany([{ name: 'B' }, { name: 'C' }]);`                               |
| Вставить документ с TTL (1 час)               | `await col.insert({ data: 'temp', ttl: 3600000 });`                                  |
| **Документы - Чтение (Read)**                 |                                                                                       |
| Получить документ по ID                       | `const doc = await col.getById('someId123');`                                        |
| Получить все документы                        | `const allDocs = await col.getAll();`                                                 |
| Найти документы по условию                    | `await col.find({ age: { $gt: 30 }, status: 'active' });`                             |
| Найти один документ по условию                | `await col.findOne({ email: 'a@b.c' });`                                              |
| Подсчитать количество документов              | `const count = await col.count();`                                                    |
| **Документы - Обновление (Update)**           |                                                                                       |
| Обновить документ по ID (частично)            | `await col.update('id123', { status: 'completed', score: 100 });`                   |
| Обновить один по фильтру (с операторами)      | `await col.updateOne({ status: 'pending' }, { $set: { status: 'processing' } });`    |
| Обновить несколько по фильтру                 | `await col.updateMany({ category: 'X' }, { $set: { processed: true } });`            |
| Найти и обновить (вернуть новый)              | `await col.findOneAndUpdate({ status: 'new' }, { $set: { status: 'claimed' } });`   |
| **Документы - Удаление (Delete)**             |                                                                                       |
| Удалить документ по ID                        | `await col.remove('id456');`                                                          |
| Удалить один по фильтру                       | `await col.deleteOne({ status: 'archived' });`                                       |
| Удалить несколько по фильтру                  | `await col.deleteMany({ timestamp: { $lt: Date.now() - 86400000 } });`              |
| Очистить всю коллекцию                        | `await col.clear();`                                                                  |
| **Индексы**                                   |                                                                                       |
| Создать стандартный индекс                    | `await col.createIndex('fieldName');`                                                  |
| Создать уникальный индекс                     | `await col.createIndex('email', { unique: true });`                                   |
| Получить список индексов                      | `const indexes = await col.getIndexes();`                                             |
| Удалить индекс                                | `await col.dropIndex('fieldName');`                                                    |
| **Транзакции**                                |                                                                                       |
| Начать транзакцию                             | `const txn = db.beginTransaction();`                                                  |
| Получить коллекцию в транзакции               | `const txnCol = txn.collection('myCollection');`                                     |
| Зарегистрировать операцию и применить         | `await txnCol.insert(...); await txn.commit();`                                       |
| Откатить транзакцию                           | `await txn.rollback();`                                                               |