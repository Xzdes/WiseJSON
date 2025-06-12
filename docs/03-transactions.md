```markdown
docs/03-transactions.md
# 03 - Работа с Транзакциями

Транзакции в WiseJSON DB позволяют сгруппировать несколько операций записи (таких как вставка, обновление, удаление) в одну атомарную единицу. Это означает, что либо все операции в транзакции успешно выполняются и их изменения сохраняются, либо, если возникает ошибка на любом этапе до коммита, ни одна из операций не применяется, и база данных остается в состоянии, предшествующем началу транзакции. Транзакции обеспечивают **консистентность данных** при выполнении сложных, многошаговых изменений.

WiseJSON DB поддерживает транзакции, которые могут затрагивать одну или несколько коллекций в рамках одного экземпляра базы данных.

**Предполагается, что у вас уже есть инициализированный экземпляр `WiseJSON` (переменная `db`), как описано в разделе `00-introduction-and-setup.md`.**

## Когда использовать транзакции?

Транзакции полезны в следующих случаях:

*   **Атомарность нескольких операций**: Когда вам нужно, чтобы несколько связанных изменений данных произошли "все или ничего". Классический пример — перевод средств со счета на счет: списание с одного счета и зачисление на другой должны либо оба выполниться, либо оба отмениться.
*   **Согласованность данных при сложных изменениях**: Если вы обновляете несколько документов в разных коллекциях, которые логически связаны, транзакция поможет избежать состояния, когда часть данных обновлена, а часть — нет, из-за ошибки в середине процесса.
*   **Изоляция (частичная)**: Хотя WiseJSON DB не предоставляет уровни изоляции транзакций как в традиционных SQL СУБД, операции внутри транзакции не видны другим частям приложения до момента вызова `commit()`.

## Как работать с транзакциями

Процесс работы с транзакциями включает следующие шаги:

### Шаг 1: Начало транзакции

Чтобы начать транзакцию, вызовите метод `db.beginTransaction()`. Этот метод возвращает объект транзакции, через который вы будете выполнять операции.

```javascript
const txn = db.beginTransaction();
```

### Шаг 2: Получение коллекций для операций в транзакции

Для выполнения операций с документами внутри транзакции, вы должны получить "транзакционную" версию коллекции через объект транзакции, используя метод `txn.collection('collectionName')`.

```javascript
const usersTxnCollection = txn.collection('users');
const logsTxnCollection = txn.collection('logs');
// Важно: для транзакционных коллекций НЕ нужно вызывать initPromise.
// Предполагается, что "родительские" коллекции уже инициализированы (await db.collection('users').initPromise и т.д.)
```

### Шаг 3: Выполнение операций

Теперь вы можете вызывать методы `insert`, `insertMany`, `update`, `remove`, `clear` на этих транзакционных коллекциях.
**Важно:** Эти операции не применяются к базе данных немедленно. Они лишь регистрируются внутри объекта транзакции и будут выполнены только после вызова `txn.commit()`. Также, в текущей реализации, эти транзакционные методы **не возвращают** измененные или вставленные документы (они возвращают `Promise<void>`). Если вам нужны ID сгенерированных документов для последующих операций в той же транзакции, вам нужно генерировать их самостоятельно и передавать в `insert`.

```javascript
// Пример операций внутри транзакции
const newUserId = `user-${Date.now()}`; // Генерируем ID заранее

await usersTxnCollection.insert({
  _id: newUserId,
  name: 'Diana Prince',
  department: 'Justice League'
});

await logsTxnCollection.insert({
  timestamp: new Date().toISOString(),
  action: 'USER_CREATED_IN_TXN',
  userId: newUserId,
  details: 'User Diana Prince added via transaction'
});
```

### Шаг 4: Завершение транзакции

У вас есть два способа завершить транзакцию:

*   **`await txn.commit()`**: Если все операции, зарегистрированные в транзакции, должны быть применены, вызовите `commit()`. WiseJSON DB сначала запишет все операции транзакционного блока в WAL-файлы соответствующих коллекций, а затем применит изменения к данным в памяти. Если на каком-либо этапе коммита (особенно при записи в WAL) произойдет ошибка, вся транзакция может быть не применена или применена частично (но WAL гарантирует, что при восстановлении незавершенные транзакции не будут применены).
*   **`await txn.rollback()`**: Если возникла ошибка или вы решили отменить изменения до вызова `commit()`, вызовите `rollback()`. Этот метод просто отменяет все зарегистрированные в транзакции операции, и никаких изменений в базе данных не происходит. `rollback()` можно вызывать только если `commit()` еще не был вызван.

### Полный Пример Сценария с `commit`

Этот пример демонстрирует создание нового пользователя и запись лога об этом событии в рамках одной транзакции.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function transactionCommitExample() {
  const dbPath = path.resolve(__dirname, 'myAppDb_transactions');
  let db;

  try {
    db = new WiseJSON(dbPath);
    await db.init();

    // Убедимся, что коллекции существуют и инициализированы
    const usersCollection = await db.collection('users');
    await usersCollection.initPromise;
    const logsCollection = await db.collection('logs');
    await logsCollection.initPromise;

    // Очистим для чистоты примера
    await usersCollection.clear();
    await logsCollection.clear();

    // Начинаем транзакцию
    const txn = db.beginTransaction();
    const newUserId = `user-tx-${Date.now()}`;

    try {
      // Получаем транзакционные обертки для коллекций
      const txnUsers = txn.collection('users');
      const txnLogs = txn.collection('logs');

      console.log('Регистрируем операции в транзакции...');
      // Операция 1: Вставка нового пользователя
      await txnUsers.insert({
        _id: newUserId,
        name: 'Clark Kent',
        email: 'clark@dailyplanet.com'
      });
      console.log(`- Пользователь ${newUserId} запланирован для вставки.`);

      // Операция 2: Запись лога о создании пользователя
      await txnLogs.insert({
        timestamp: new Date().toISOString(),
        event: 'USER_REGISTRATION_TXN',
        userId: newUserId,
        message: 'Пользователь Clark Kent зарегистрирован.'
      });
      console.log('- Запись в лог запланирована.');

      // Если все операции успешно зарегистрированы, коммитим транзакцию
      console.log('Применяем транзакцию (commit)...');
      await txn.commit();
      console.log('Транзакция успешно применена.');

    } catch (transactionError) {
      console.error('Ошибка внутри блока транзакции, откатываем:', transactionError);
      await txn.rollback(); // Откатываем изменения, если что-то пошло не так до commit
      console.log('Транзакция отменена (rollback).');
      // Пробрасываем ошибку дальше, чтобы внешний try...catch ее поймал
      throw transactionError;
    }

    // Проверяем результаты после коммита
    const createdUser = await usersCollection.getById(newUserId);
    const logEntry = await logsCollection.findOne(log => log.userId === newUserId);

    console.log('Созданный пользователь:', createdUser);
    console.log('Запись в логе:', logEntry);

    if (!createdUser || !logEntry) {
        throw new Error('Данные после коммита транзакции не найдены!');
    }


  } catch (error) {
    console.error('Общая ошибка в примере с транзакцией (commit):', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

transactionCommitExample();
```

### Полный Пример Сценария с `rollback`

Этот пример показывает, как транзакция может быть отменена.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function transactionRollbackExample() {
  const dbPath = path.resolve(__dirname, 'myAppDb_transactions'); // Используем ту же БД
  let db;

  try {
    db = new WiseJSON(dbPath);
    await db.init();

    const accountsCollection = await db.collection('accounts');
    await accountsCollection.initPromise;
    await accountsCollection.clear();

    // Начальные данные
    const acc1 = await accountsCollection.insert({ _id: 'acc101', balance: 100 });
    const acc2 = await accountsCollection.insert({ _id: 'acc102', balance: 50 });

    console.log('Балансы до транзакции:');
    console.log('Аккаунт acc101:', (await accountsCollection.getById('acc101')).balance);
    console.log('Аккаунт acc102:', (await accountsCollection.getById('acc102')).balance);

    // Начинаем транзакцию для перевода средств
    const txn = db.beginTransaction();
    const transferAmount = 30;
    let simulateError = true; // Установите в false, чтобы транзакция прошла успешно

    try {
      const txnAccounts = txn.collection('accounts');

      console.log('\nРегистрируем операции перевода средств...');
      // Списание с acc101
      await txnAccounts.update('acc101', { balance: acc1.balance - transferAmount });
      console.log(`- Списание ${transferAmount} с acc101 запланировано.`);

      // Имитируем ошибку перед зачислением
      if (simulateError) {
        throw new Error('Симулированная ошибка перед зачислением средств!');
      }

      // Зачисление на acc102
      await txnAccounts.update('acc102', { balance: acc2.balance + transferAmount });
      console.log(`- Зачисление ${transferAmount} на acc102 запланировано.`);

      console.log('Применяем транзакцию (commit)...');
      await txn.commit();
      console.log('Транзакция перевода средств успешно применена.');

    } catch (transactionError) {
      console.error('\nОшибка во время операций транзакции:', transactionError.message);
      console.log('Откатываем транзакцию (rollback)...');
      await txn.rollback();
      console.log('Транзакция отменена.');
    }

    // Проверяем балансы после транзакции
    console.log('\nБалансы после транзакции:');
    const finalAcc1 = await accountsCollection.getById('acc101');
    const finalAcc2 = await accountsCollection.getById('acc102');
    console.log('Аккаунт acc101:', finalAcc1.balance);
    console.log('Аккаунт acc102:', finalAcc2.balance);

    if (simulateError) {
      if (finalAcc1.balance !== 100 || finalAcc2.balance !== 50) {
        throw new Error('Rollback не сработал корректно, балансы изменились!');
      }
      console.log('Балансы остались неизменными, rollback успешен.');
    } else {
      if (finalAcc1.balance !== 70 || finalAcc2.balance !== 80) {
         throw new Error('Commit не сработал корректно, балансы неверные!');
      }
      console.log('Балансы изменены, commit успешен.');
    }


  } catch (error) {
    console.error('Общая ошибка в примере с транзакцией (rollback):', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

transactionRollbackExample();
```

### Важные Замечания по Транзакциям

*   **Производительность**: Транзакции, особенно затрагивающие множество операций или коллекций, могут быть медленнее отдельных операций из-за дополнительных накладных расходов на управление состоянием транзакции и запись в WAL.
*   **Генерация ID**: Как упоминалось, если вам нужны ID документов, сгенерированные базой данных, внутри той же транзакции для последующих операций, стандартный API транзакций WiseJSON DB (где `insert` не возвращает сам документ) этого не позволяет напрямую. В таких случаях генерируйте ID на стороне клиента (например, с помощью `uuid`) перед вставкой.
*   **Ошибки при `commit`**: Если `txn.commit()` выбрасывает ошибку (например, из-за невозможности записать WAL-файл), состояние данных может быть неконсистентным между различными коллекциями, если транзакция затрагивала несколько. Однако, механизм восстановления WiseJSON DB из WAL при следующем запуске не применит незавершенные (без записи о коммите в WAL) транзакционные блоки, что помогает поддерживать консистентность на уровне отдельных коллекций.
*   **Длительные транзакции**: Избегайте очень длительных транзакций, которые удерживают ресурсы или блокируют другие операции надолго (хотя WiseJSON DB не использует традиционные блокировки строк/таблиц во время выполнения операций внутри транзакции до коммита, файловая блокировка на уровне коллекции может быть задействована при коммите).

Транзакции — мощный инструмент для обеспечения целостности данных в сложных сценариях. Используйте их обдуманно, когда требуется атомарность нескольких операций.