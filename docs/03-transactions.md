```markdown
# 03 - Работа с Транзакциями

Транзакции в WiseJSON DB позволяют сгруппировать несколько операций записи (таких как вставка, обновление, удаление) в одну атомарную единицу. Это гарантирует, что либо все операции в транзакции успешно выполняются и их изменения сохраняются, либо, если на любом этапе до фиксации (commit) возникает ошибка, ни одна из операций не применяется, и база данных остается в состоянии, предшествующем началу транзакции.

Транзакции обеспечивают **консистентность данных** при выполнении сложных, многошаговых изменений и могут затрагивать одну или несколько коллекций в рамках одного экземпляра базы данных.

**Предполагается, что у вас уже есть инициализированный экземпляр `WiseJSON` (переменная `db`), как описано в разделе `00-introduction-and-setup.md`.**

## Когда использовать транзакции?

Транзакции незаменимы в следующих случаях:

*   **Атомарность нескольких операций**: Когда вам нужно, чтобы несколько связанных изменений данных произошли по принципу "все или ничего". Классический пример — перевод средств со счета на счет: списание с одного счета и зачисление на другой должны либо оба выполниться, либо оба отмениться.
*   **Согласованность данных при сложных изменениях**: Если вы обновляете несколько логически связанных документов (возможно, в разных коллекциях), транзакция предотвратит состояние, когда часть данных обновлена, а часть — нет, из-за ошибки в середине процесса.
*   **Изоляция**: Операции внутри транзакции не видны другим частям приложения до момента вызова `commit()`. Это обеспечивает базовый уровень изоляции и предотвращает чтение "грязных" или неполных данных.

## Как работать с транзакциями

Процесс работы с транзакциями включает четыре основных шага:

### Шаг 1: Начало транзакции

Чтобы начать транзакцию, вызовите метод `db.beginTransaction()`. Этот метод возвращает объект транзакции (`txn`), через который вы будете выполнять все последующие операции.

```javascript
const txn = db.beginTransaction();
```

### Шаг 2: Получение транзакционных коллекций

Для выполнения операций внутри транзакции вы должны получить "транзакционную" версию коллекции через объект транзакции, используя метод `txn.collection('collectionName')`.

*   **Важно:** Для транзакционных коллекций **НЕ нужно** вызывать `initPromise`. Предполагается, что "родительские" коллекции уже были инициализированы при запуске приложения (например, `await db.collection('users').initPromise`).

```javascript
// Получаем обертки для коллекций, которые будут участвовать в транзакции
const usersTxn = txn.collection('users');
const logsTxn = txn.collection('logs');
```

### Шаг 3: Выполнение операций

Теперь вы можете вызывать методы записи (`insert`, `insertMany`, `update`, `remove`, `clear`) на этих транзакционных коллекциях.

*   **Ключевой момент:** Эти операции не применяются к базе данных немедленно. Они лишь регистрируются внутри объекта транзакции и будут выполнены единым блоком только после вызова `txn.commit()`.
*   **Возвращаемые значения:** Транзакционные методы записи в текущей реализации **не возвращают** результат операции (например, вставленный документ). Они возвращают `Promise<void>`.
*   **Генерация ID:** Если вам нужен ID нового документа для последующих операций в той же транзакции (например, вставить пользователя и сразу же записать лог с его ID), вы должны **сгенерировать этот ID на стороне клиента** перед вызовом `insert`.

```javascript
// Генерируем ID пользователя заранее, так как он понадобится для лога
const { v4: uuidv4 } = require('uuid');
const newUserId = uuidv4();

// Регистрируем операции в транзакции
await usersTxn.insert({
  _id: newUserId,
  name: 'Diana Prince',
  department: 'Justice League'
});

await logsTxn.insert({
  timestamp: new Date().toISOString(),
  action: 'USER_CREATED_IN_TXN',
  userId: newUserId, // Используем заранее сгенерированный ID
  details: 'User Diana Prince added via transaction'
});
```

### Шаг 4: Завершение транзакции (`commit` или `rollback`)

У вас есть два способа завершить транзакцию:

*   **`await txn.commit()`**: Если все операции должны быть применены, вызовите `commit()`. WiseJSON DB атомарно запишет все зарегистрированные операции в WAL-файлы соответствующих коллекций и применит изменения к данным в памяти. Если на этом этапе произойдет сбой, механизм восстановления из WAL гарантирует, что незавершенная транзакция не будет применена, сохраняя целостность данных.
*   **`await txn.rollback()`**: Если возникла ошибка или вы решили отменить изменения до вызова `commit()`, вызовите `rollback()`. Этот метод просто отменяет все зарегистрированные в транзакции операции, и никаких изменений в базе данных не происходит.

#### Полный Пример Сценария с `commit`

Этот пример демонстрирует создание нового пользователя и запись лога об этом событии в рамках одной атомарной операции.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

async function transactionCommitExample() {
  const db = new WiseJSON(path.resolve(__dirname, 'myAppDb'));
  await db.init();
  const usersCollection = await db.collection('users');
  await usersCollection.initPromise;
  const logsCollection = await db.collection('logs');
  await logsCollection.initPromise;
  
  // Начинаем транзакцию
  const txn = db.beginTransaction();
  const newUserId = uuidv4();

  try {
    const txnUsers = txn.collection('users');
    const txnLogs = txn.collection('logs');

    console.log('Регистрируем операции в транзакции...');
    await txnUsers.insert({
      _id: newUserId,
      name: 'Clark Kent',
      email: 'clark@dailyplanet.com'
    });
    await txnLogs.insert({
      event: 'USER_REGISTRATION_TXN',
      userId: newUserId,
      timestamp: new Date().toISOString()
    });
    
    // Если все успешно, коммитим транзакцию
    console.log('Применяем транзакцию (commit)...');
    await txn.commit();
    console.log('Транзакция успешно применена.');

  } catch (transactionError) {
    console.error('Ошибка внутри блока транзакции, откатываем:', transactionError);
    await txn.rollback();
    console.log('Транзакция отменена (rollback).');
  } finally {
    if (db) {
        await db.close();
    }
  }
}

transactionCommitExample();
```

#### Полный Пример Сценария с `rollback`

Этот пример показывает, как транзакция отменяется при возникновении ошибки. Предположим, у нас есть коллекция `accounts` с документами `{ _id: 'acc1', balance: 100 }` и `{ _id: 'acc2', balance: 50 }`.

```javascript
// ... инициализация db и коллекции 'accounts' ...

const txn = db.beginTransaction();
const transferAmount = 30;

try {
  const txnAccounts = txn.collection('accounts');

  // Списание с acc1
  await txnAccounts.update('acc1', { balance: 100 - transferAmount });
  console.log('Списание запланировано.');

  // Имитируем ошибку (например, проверка показала, что получатель заблокирован)
  throw new Error('Получатель не может принять перевод!');

  // Этот код не выполнится
  await txnAccounts.update('acc2', { balance: 50 + transferAmount });
  await txn.commit();

} catch (transactionError) {
  console.error('Ошибка во время транзакции:', transactionError.message);
  console.log('Откатываем транзакцию (rollback)...');
  await txn.rollback();
  console.log('Транзакция отменена. Балансы остались неизменными.');
}

// Проверка после транзакции покажет, что балансы не изменились.
```

### Важные Замечания по Транзакциям

*   **Производительность**: Транзакции, особенно затрагивающие множество операций или коллекций, могут быть немного медленнее отдельных операций из-за накладных расходов на управление состоянием транзакции и запись в WAL. Используйте их там, где целостность данных важнее максимальной скорости.
*   **Ошибки при `commit`**: Если `txn.commit()` выбрасывает ошибку (например, из-за невозможности записать на диск), состояние данных останется консистентным. Механизм восстановления WiseJSON DB из WAL при следующем запуске не применит незавершенные транзакционные блоки.
*   **Длительные транзакции**: Избегайте очень длительных транзакций, которые могут долго удерживать ресурсы. Хотя WiseJSON DB не использует традиционные блокировки строк/таблиц до момента коммита, файловая блокировка на уровне коллекции может быть задействована при фиксации транзакции.