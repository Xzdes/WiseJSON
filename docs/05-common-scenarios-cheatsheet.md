```markdown
docs/05-common-scenarios-cheatsheet.md
# 05 - Распространенные Сценарии Использования и Шпаргалка

Этот раздел содержит полные примеры кода для некоторых типичных задач, которые можно решать с помощью WiseJSON DB, а также краткую шпаргалку по основным операциям.

## Сценарий 1: Простое Хранилище Пользовательских Профилей

**Задача:** Создать приложение, которое хранит профили пользователей (имя, email, возраст), позволяет добавлять новых пользователей, находить их по email и обновлять информацию.

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
    console.log('Коллекция "profiles" готова.');

    // Для чистоты примера, очистим коллекцию при каждом запуске
    await profiles.clear();

    // Создадим уникальный индекс по email для быстрого поиска и предотвращения дубликатов
    await profiles.createIndex('email', { unique: true });
    console.log('Уникальный индекс по "email" создан.');

    // Добавление новых профилей
    console.log('\nДобавляем профили...');
    const profile1 = await profiles.insert({
      name: 'Елена Смирнова',
      email: 'elena@example.com',
      age: 28,
      city: 'Москва'
    });
    console.log('Добавлен профиль:', profile1);

    const profile2 = await profiles.insert({
      name: 'Алексей Иванов',
      email: 'alex@example.com',
      age: 34,
      city: 'Санкт-Петербург'
    });
    console.log('Добавлен профиль:', profile2);

    // Попытка добавить пользователя с существующим email (вызовет ошибку из-за уникального индекса)
    try {
      await profiles.insert({ name: 'Другая Елена', email: 'elena@example.com', age: 30 });
    } catch (e) {
      console.log(`\nОжидаемая ошибка: ${e.message}`); // Сообщение о дубликате
    }

    // Поиск профиля по email (используя индекс)
    console.log('\nИщем профиль Алексея по email...');
    const foundAlex = await profiles.findOneByIndexedValue('email', 'alex@example.com');
    if (foundAlex) {
      console.log('Найден профиль:', foundAlex);

      // Обновление информации в профиле Алексея
      console.log('\nОбновляем город Алексея...');
      const updatedAlex = await profiles.update(foundAlex._id, { city: 'Новосибирск', age: 35 });
      if (updatedAlex) {
        console.log('Обновленный профиль Алексея:', updatedAlex);
      }
    } else {
      console.log('Профиль Алексея не найден.');
    }

    // Получение всех профилей
    console.log('\nВсе профили в базе:');
    const allProfiles = await profiles.getAll();
    allProfiles.forEach(p => console.log(`- ${p.name} (${p.email}), ${p.age} лет, город: ${p.city}`));

  } catch (error) {
    console.error('Ошибка в сценарии управления профилями:', error);
  } finally {
    if (db) {
      await db.close();
      console.log('\nБаза данных профилей закрыта.');
    }
  }
}

userProfileManagement();
```

## Сценарий 2: Логирование Событий с Автоматическим Удалением Старых Логов (TTL)

**Задача:** Записывать события приложения в коллекцию логов. Старые логи (например, старше 7 дней) должны автоматически удаляться.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function eventLoggingWithTTL() {
  const dbPath = path.resolve(__dirname, 'eventLogsDb');
  let db;

  // Настроим частую проверку TTL для демонстрации (каждые 5 секунд)
  // В реальном приложении интервал может быть больше (например, раз в час)
  const dbOptions = {
    ttlCleanupIntervalMs: 5000 // 5 секунд
  };

  try {
    db = new WiseJSON(dbPath, dbOptions);
    await db.init();
    console.log('База данных логов инициализирована.');

    const eventLogs = await db.collection('event_logs');
    await eventLogs.initPromise;
    console.log('Коллекция "event_logs" готова.');
    // await eventLogs.clear(); // Можно очистить для нового запуска примера

    // Записываем несколько событий
    console.log('\nЗаписываем события...');
    await eventLogs.insert({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: 'Приложение запущено.',
      // Этот лог будет жить 7 дней (в миллисекундах)
      ttl: 7 * 24 * 60 * 60 * 1000
    });

    await eventLogs.insert({
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      message: 'Отладочное сообщение, исчезнет через 10 секунд.',
      ttl: 10000 // 10 секунд
    });

    const criticalEvent = await eventLogs.insert({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: 'Произошла критическая ошибка!',
      // Этот лог будет жить 30 дней
      expireAt: Date.now() + 30 * 24 * 60 * 60 * 1000
    });
    console.log('События записаны.');

    let currentLogCount = await eventLogs.count();
    console.log(`\nТекущее количество логов: ${currentLogCount}`); // Ожидаем 3

    console.log('\nОжидаем 12 секунд, чтобы отладочный лог истек...');
    await new Promise(resolve => setTimeout(resolve, 12000));

    // После ожидания, при следующем обращении к коллекции (например, count или getAll),
    // или по таймеру ttlCleanupIntervalMs, устаревший лог должен быть удален.
    currentLogCount = await eventLogs.count();
    console.log(`Количество логов после ожидания: ${currentLogCount}`); // Ожидаем 2

    console.log('\nОставшиеся логи:');
    const remainingLogs = await eventLogs.getAll();
    remainingLogs.forEach(log => console.log(`- [${log.level}] ${log.message}`));

    // Проверим, что критическое событие все еще на месте
    const foundCriticalEvent = await eventLogs.getById(criticalEvent._id);
    console.log(`\nКритическое событие найдено: ${!!foundCriticalEvent}`);


  } catch (error) {
    console.error('Ошибка в сценарии логирования событий:', error);
  } finally {
    if (db) {
      await db.close();
      console.log('\nБаза данных логов закрыта.');
    }
  }
}

eventLoggingWithTTL();
```

## Сценарий 3: Регистрация Пользователя и Создание Начального Баланса (Транзакция)

**Задача:** При регистрации нового пользователя необходимо создать запись о нем в коллекции `users` и одновременно создать запись о его начальном балансе (например, 0) в коллекции `balances`. Обе операции должны быть выполнены атомарно.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // Для генерации ID

async function userRegistrationWithBalance() {
  const dbPath = path.resolve(__dirname, 'registrationDb');
  let db;

  try {
    db = new WiseJSON(dbPath);
    await db.init();
    console.log('База данных регистрации инициализирована.');

    const users = await db.collection('users_reg');
    await users.initPromise;
    const balances = await db.collection('balances_reg');
    await balances.initPromise;
    console.log('Коллекции "users_reg" и "balances_reg" готовы.');

    // Очистим для нового запуска
    await users.clear();
    await balances.clear();

    const newUserEmail = 'newuser@example.com';
    const newUserName = 'Новый Пользователь';
    // Генерируем ID пользователя заранее, т.к. он нужен для обеих операций в транзакции
    // и операции в транзакции не возвращают результат до commit.
    const newUserId = uuidv4();

    // Начинаем транзакцию
    const txn = db.beginTransaction();
    console.log(`\nНачинаем транзакцию для регистрации пользователя ${newUserId}...`);

    try {
      // Получаем транзакционные обертки для коллекций
      const txnUsers = txn.collection('users_reg');
      const txnBalances = txn.collection('balances_reg');

      // Операция 1: Создание пользователя
      await txnUsers.insert({
        _id: newUserId,
        name: newUserName,
        email: newUserEmail,
        registeredAt: new Date().toISOString()
      });
      console.log(`- Пользователь ${newUserName} (${newUserId}) запланирован к созданию.`);

      // Имитация возможной проверки перед созданием баланса
      // if (некое_условие_не_выполнено) {
      //   throw new Error("Не удалось создать баланс, условие не выполнено.");
      // }

      // Операция 2: Создание начального баланса для пользователя
      await txnBalances.insert({
        _id: `balance_${newUserId}`, // Связанный ID баланса
        userId: newUserId,
        currency: 'USD',
        amount: 0, // Начальный баланс
        createdAt: new Date().toISOString()
      });
      console.log(`- Начальный баланс для пользователя ${newUserId} запланирован к созданию.`);

      // Если все операции успешно зарегистрированы, коммитим транзакцию
      console.log('Применяем транзакцию (commit)...');
      await txn.commit();
      console.log('Транзакция регистрации успешно применена.');

    } catch (transactionError) {
      console.error('\nОшибка внутри транзакции регистрации, откатываем:', transactionError.message);
      await txn.rollback();
      console.log('Транзакция отменена (rollback).');
      // Можно пробросить ошибку дальше, если это требуется логикой приложения
      // throw transactionError;
    }

    // Проверяем результаты
    console.log('\nПроверяем данные после транзакции...');
    const registeredUser = await users.getById(newUserId);
    const userBalance = await balances.findOne(b => b.userId === newUserId);

    if (registeredUser && userBalance) {
      console.log('Зарегистрированный пользователь:', registeredUser);
      console.log('Баланс пользователя:', userBalance);
      console.log('Регистрация прошла успешно!');
    } else if (!registeredUser && !userBalance) {
      console.log('Пользователь и баланс не созданы (вероятно, был rollback).');
    } else {
      console.error('Ошибка: данные неконсистентны! Пользователь или баланс отсутствует.');
    }

  } catch (error) {
    console.error('Общая ошибка в сценарии регистрации:', error);
  } finally {
    if (db) {
      await db.close();
      console.log('\nБаза данных регистрации закрыта.');
    }
  }
}

userRegistrationWithBalance();
```

## Шпаргалка (Cheatsheet) по Основным Операциям

| Задача                                        | Метод API / Пример Кода                                                               |
| :-------------------------------------------- | :------------------------------------------------------------------------------------ |
| **Инициализация**                             |                                                                                       |
| Подключить библиотеку                         | `const WiseJSON = require('wise-json-db'); const path = require('path');`            |
| Создать экземпляр БД                         | `const db = new WiseJSON(path.resolve(__dirname, 'dbName'));`                        |
| Инициализировать БД                           | `await db.init();`                                                                    |
| Получить/создать коллекцию                    | `const col = await db.collection('collectionName');`                                 |
| Дождаться инициализации коллекции             | `await col.initPromise;`                                                              |
| Закрыть БД (сохранить всё)                    | `await db.close();`                                                                   |
| **Документы - Создание**                      |                                                                                       |
| Вставить один документ                        | `await col.insert({ name: 'A', value: 1 });`                                          |
| Вставить массив документов                    | `await col.insertMany([{ name: 'B' }, { name: 'C' }]);`                               |
| Вставить документ с TTL (1 час)               | `await col.insert({ data: 'temp', ttl: 3600000 });`                                  |
| Вставить документ с временем истечения         | `await col.insert({ data: 'exp', expireAt: Date.now() + 60000 });`                   |
| **Документы - Чтение**                        |                                                                                       |
| Получить документ по ID                       | `const doc = await col.getById('someId123');`                                        |
| Получить все документы                        | `const allDocs = await col.getAll();`                                                 |
| Найти документы по условию                    | `const results = await col.find(doc => doc.age > 30 && doc.active);`                |
| Найти один документ по условию                | `const oneResult = await col.findOne(doc => doc.email === 'a@b.c');`                 |
| Подсчитать количество документов              | `const count = await col.count();`                                                    |
| **Документы - Обновление**                    |                                                                                       |
| Обновить документ по ID                       | `await col.update('id123', { status: 'completed', score: 100 });`                   |
| Обновить несколько по условию                 | `await col.updateMany(doc => doc.category === 'X', { processed: true });`            |
| **Документы - Удаление**                      |                                                                                       |
| Удалить документ по ID                        | `await col.remove('id456');`                                                          |
| Удалить несколько по условию                  | `await col.removeMany(doc => doc.timestamp < Date.now() - 86400000);`              |
| Очистить всю коллекцию                        | `await col.clear();`                                                                  |
| **Индексы**                                   |                                                                                       |
| Создать стандартный индекс                    | `await col.createIndex('fieldName');`                                                  |
| Создать уникальный индекс                     | `await col.createIndex('uniqueField', { unique: true });`                             |
| Найти по стандартному индексу                 | `await col.findByIndexedValue('fieldName', 'targetValue');`                           |
| Найти по уникальному индексу (один)           | `await col.findOneByIndexedValue('uniqueField', 'uniqueValue');`                     |
| Получить список индексов                      | `const indexes = await col.getIndexes();`                                             |
| Удалить индекс                                | `await col.dropIndex('fieldName');`                                                    |
| **Транзакции**                                |                                                                                       |
| Начать транзакцию                             | `const txn = db.beginTransaction();`                                                  |
| Получить коллекцию в транзакции               | `const txnCol = txn.collection('myCollection');`                                     |
| Зарегистрировать операцию в транзакции        | `await txnCol.insert({ data: 'in_txn' });`                                            |
| Применить транзакцию                          | `await txn.commit();`                                                                 |
| Откатить транзакцию                           | `await txn.rollback();`                                                               |
| **Импорт/Экспорт**                            |                                                                                       |
| Экспорт в JSON                                | `await col.exportJson('backup.json');`                                                |
| Экспорт в CSV                                 | `await col.exportCsv('backup.csv');`                                                  |
| Импорт из JSON (добавить)                     | `await col.importJson('data.json');` /* или { mode: 'append' } */                   |
| Импорт из JSON (заменить)                     | `await col.importJson('data.json', { mode: 'replace' });`                           |