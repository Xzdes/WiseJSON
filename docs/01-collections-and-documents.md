```markdown
docs/01-collections-and-documents.md
# 01 - Работа с Коллекциями и Документами

В этом разделе подробно рассматриваются основные операции по управлению данными (CRUD - Create, Read, Update, Delete) в коллекциях WiseJSON DB, а также установка времени жизни (TTL) для документов и их подсчет.

**Предполагается, что у вас уже есть инициализированный экземпляр `WiseJSON` (переменная `db`) и получен экземпляр коллекции с дождавшимся `initPromise` (переменная `collection`), как описано в разделе `00-introduction-and-setup.md`.**

## Добавление Документов

### Как добавить один документ (`insert`)

Метод `collection.insert(document)` используется для добавления одного нового документа в коллекцию.

*   **Параметры:**
    *   `document {object}`: JavaScript-объект, который вы хотите сохранить.
        *   Если вы предоставите поле `_id` в объекте `document`, оно будет использовано как уникальный идентификатор.
        *   Если поле `_id` не предоставлено, WiseJSON DB автоматически сгенерирует уникальный `_id`.
*   **Возвращает:** `Promise<object>` - Промис, который разрешается объектом вставленного документа. Этот объект будет содержать поля `_id` (даже если сгенерирован автоматически), `createdAt` (время создания в формате ISO-строки) и `updatedAt` (время последнего обновления, изначально совпадает с `createdAt`).
*   **Ошибки:** Может выбросить ошибку, если, например, нарушается уникальность индекса (подробнее об индексах в соответствующем разделе).

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function addSingleDocument() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const usersCollection = await db.collection('users');
    await usersCollection.initPromise;

    // Добавляем новый документ
    const newUser = await usersCollection.insert({
      name: 'Alice Wonder',
      email: 'alice@example.com',
      age: 30
    });
    console.log('Добавлен пользователь:', newUser);
    // Пример вывода newUser:
    // {
    //   name: 'Alice Wonder',
    //   email: 'alice@example.com',
    //   age: 30,
    //   _id: 'генерированный_id',
    //   createdAt: '2023-10-27T10:00:00.000Z',
    //   updatedAt: '2023-10-27T10:00:00.000Z'
    // }

    // Добавляем документ с предопределенным _id
    const specificUser = await usersCollection.insert({
      _id: 'user123',
      name: 'Bob The Builder',
      role: 'admin'
    });
    console.log('Добавлен пользователь с конкретным ID:', specificUser);

  } catch (error) {
    console.error('Ошибка при добавлении документа:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

addSingleDocument();
```

### Как добавить несколько документов сразу (`insertMany`)

Метод `collection.insertMany(documentsArray)` позволяет эффективно добавить массив документов за одну операцию.

*   **Параметры:**
    *   `documentsArray {Array<object>}`: Массив JavaScript-объектов для вставки. Для каждого объекта действуют те же правила относительно `_id`, что и для `insert`.
*   **Возвращает:** `Promise<Array<object>>` - Промис, который разрешается массивом вставленных документов, каждый из которых будет содержать `_id`, `createdAt` и `updatedAt`.
*   **Поведение при ошибках:** WiseJSON DB обрабатывает большие массивы в insertMany путем их разделения на более мелкие порции (чанки) для записи в журнал упреждающей записи (WAL). Если при обработке одного из таких чанков возникает ошибка (например, нарушение уникального индекса), то только этот чанк и все последующие чанки в рамках данного вызова insertMany не будут применены. Документы из успешно обработанных предыдущих чанков останутся в базе данных. Будет выброшена ошибка, относящаяся к проблемному чанку.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function addMultipleDocuments() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const productsCollection = await db.collection('products');
    await productsCollection.initPromise;

    const newProducts = [
      { name: 'Ноутбук', category: 'Электроника', price: 1200 },
      { name: 'Смартфон', category: 'Электроника', price: 800 },
      { _id: 'book-451', name: 'Книга "451 градус по Фаренгейту"', category: 'Книги', price: 15 }
    ];

    const insertedProducts = await productsCollection.insertMany(newProducts);
    console.log(`Успешно добавлено ${insertedProducts.length} продуктов:`);
    insertedProducts.forEach(p => console.log(p));

  } catch (error) {
    console.error('Ошибка при пакетном добавлении документов:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

addMultipleDocuments();
```

### Как добавить документ с ограниченным временем жизни (TTL)

WiseJSON DB позволяет устанавливать время жизни для документов, после истечения которого они будут автоматически удалены. Это делается с помощью полей `ttl` или `expireAt` в самом документе.

*   **`ttl {number}`**: Время жизни документа в миллисекундах с момента его создания (поле `createdAt`).
*   **`expireAt {number | string}`**: Точное время (Unix timestamp в миллисекундах или строка в формате ISO 8601), когда документ должен истечь и быть удален.

Если указаны оба поля, приоритет будет у `expireAt`. Очистка устаревших документов происходит периодически (настраивается опцией `ttlCleanupIntervalMs` при инициализации `WiseJSON`) или при некоторых операциях чтения.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function addDocumentsWithTTL() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    // Установим короткий интервал очистки TTL для демонстрации
    db = new WiseJSON(dbPath, { ttlCleanupIntervalMs: 5000 }); // Проверять каждые 5 секунд
    await db.init();
    const tempCollection = await db.collection('temp_data');
    await tempCollection.initPromise;

    // Документ, который "умрет" через 10 секунд после создания
    const shortLivedDoc = await tempCollection.insert({
      message: 'Это сообщение исчезнет через 10 секунд.',
      ttl: 10000 // 10 секунд
    });
    console.log('Добавлен документ с коротким TTL:', shortLivedDoc);

    // Документ, который "умрет" в определенное время (через 1 минуту от текущего)
    const specificExpiryDoc = await tempCollection.insert({
      data: 'Информация, актуальная 1 минуту.',
      expireAt: Date.now() + 60000 // Через 60 секунд
    });
    console.log('Добавлен документ с конкретным временем истечения:', specificExpiryDoc);

    console.log(`Текущее количество документов: ${await tempCollection.count()}`); // Будет 2

    // Подождем 12 секунд, чтобы shortLivedDoc точно истек и был шанс на срабатывание очистки
    console.log('Ожидаем 12 секунд для истечения TTL...');
    await new Promise(resolve => setTimeout(resolve, 12000));

    // При вызове count() также может произойти очистка TTL
    const countAfterTTL = await tempCollection.count();
    console.log(`Количество документов после ожидания: ${countAfterTTL}`); // Ожидаем 1 (specificExpiryDoc еще жив)

    const stillExists = await tempCollection.getById(specificExpiryDoc._id);
    console.log('Документ с expireAt все еще существует:', !!stillExists);


  } catch (error) {
    console.error('Ошибка при работе с TTL документами:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

addDocumentsWithTTL();
```

## Чтение Документов

Описание операций чтения (`getById`, `getAll`, `find`, `findOne`) будет в файле `02-querying-and-indexing.md`.

## Обновление Документов

### Как обновить один документ по ID (`update`)

Метод `collection.update(id, updates)` позволяет обновить поля существующего документа.

*   **Параметры:**
    *   `id {string}`: Уникальный идентификатор `_id` документа, который нужно обновить.
    *   `updates {object}`: Объект, содержащий поля и их новые значения. Поля, присутствующие в `updates`, будут изменены или добавлены в документ. Поля, отсутствующие в `updates`, останутся без изменений.
        *   **Важно:** Вы не можете изменить поле `_id` или `createdAt` с помощью этого метода. Поле `updatedAt` будет автоматически обновлено текущим временем.
*   **Возвращает:** `Promise<object | null>` - Промис, который разрешается обновленным объектом документа, если документ с таким `id` был найден и успешно обновлен. Если документ не найден, промис разрешается значением `null`.
*   **Ошибки:** Может выбросить ошибку, если обновление приведет к нарушению уникальности индекса.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function updateSingleDocument() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const usersCollection = await db.collection('users');
    await usersCollection.initPromise;

    // Сначала добавим пользователя, чтобы было что обновлять
    const userToUpdate = await usersCollection.insert({ name: 'Old Name', email: 'old@example.com', age: 25 });
    console.log('Пользователь до обновления:', userToUpdate);

    if (userToUpdate) {
      const updates = {
        name: 'New Name',
        age: 26,
        status: 'active' // Добавляем новое поле
      };
      const updatedUser = await usersCollection.update(userToUpdate._id, updates);

      if (updatedUser) {
        console.log('Пользователь после обновления:', updatedUser);
        // Пример вывода updatedUser:
        // {
        //   _id: userToUpdate._id,
        //   name: 'New Name',
        //   email: 'old@example.com', // email не изменился, т.к. не было в updates
        //   age: 26,
        //   status: 'active',
        //   createdAt: userToUpdate.createdAt,
        //   updatedAt: 'новое_время_обновления'
        // }
      } else {
        console.log(`Пользователь с ID ${userToUpdate._id} не найден для обновления.`);
      }
    }

    // Попытка обновить несуществующий документ
    const nonExistentUpdate = await usersCollection.update('non-existent-id', { name: 'Ghost' });
    console.log('Результат обновления несуществующего документа:', nonExistentUpdate); // Выведет: null

  } catch (error) {
    console.error('Ошибка при обновлении документа:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

updateSingleDocument();
```

### Как обновить несколько документов по условию (`updateMany`)

Метод `collection.updateMany(predicate, updates)` обновляет все документы в коллекции, которые соответствуют заданной функции-предикату.

*   **Параметры:**
    *   `predicate {function}`: Синхронная функция, которая будет вызвана для каждого документа в коллекции. Функция принимает один аргумент — объект документа, и должна вернуть `true`, если документ нужно обновить, или `false` в противном случае.
        *   Пример предиката: `(doc) => doc.category === 'Электроника' && doc.price < 1000`
    *   `updates {object}`: Объект с полями для обновления, аналогично методу `update`.
*   **Возвращает:** `Promise<number>` - Промис, который разрешается числом — количеством успешно обновленных документов.
*   **Поведение при ошибках:** Если при обновлении одного из документов возникает ошибка (например, нарушение уникального индекса), операция `updateMany` прервется на этом документе, и ошибка будет выброшена. Документы, обработанные до ошибки, останутся обновленными. Возвращаемое значение в случае ошибки не определено (т.к. промис будет отклонен).

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function updateMultipleDocuments() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const productsCollection = await db.collection('products_for_update'); // Используем новую коллекцию для чистоты
    await productsCollection.initPromise;
    await productsCollection.clear(); // Очистим на всякий случай

    await productsCollection.insertMany([
      { name: 'Товар A', category: 'cat1', status: 'pending', stock: 10 },
      { name: 'Товар B', category: 'cat2', status: 'pending', stock: 5 },
      { name: 'Товар C', category: 'cat1', status: 'active', stock: 20 },
      { name: 'Товар D', category: 'cat1', status: 'pending', stock: 0 },
    ]);

    // Обновим статус всех товаров категории 'cat1' со статусом 'pending' на 'processing'
    // и добавим поле 'lastChecked'
    const predicate = (doc) => doc.category === 'cat1' && doc.status === 'pending';
    const updates = { status: 'processing', lastChecked: new Date().toISOString() };

    const updatedCount = await productsCollection.updateMany(predicate, updates);
    console.log(`Обновлено ${updatedCount} документов.`); // Ожидаем 2 (Товар A, Товар D)

    // Проверим результат
    const updatedDocs = await productsCollection.find(doc => doc.status === 'processing');
    console.log('Документы со статусом "processing":');
    updatedDocs.forEach(doc => console.log(doc));

  } catch (error) {
    console.error('Ошибка при пакетном обновлении документов:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

updateMultipleDocuments();
```

## Удаление Документов

### Как удалить один документ по ID (`remove`)

Метод `collection.remove(id)` удаляет один документ из коллекции по его `_id`.

*   **Параметры:**
    *   `id {string}`: Уникальный идентификатор `_id` документа для удаления.
*   **Возвращает:** `Promise<boolean>` - Промис, который разрешается значением `true`, если документ был найден и успешно удален. Если документ с таким `id` не найден, промис разрешается значением `false`.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function removeSingleDocument() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const itemsCollection = await db.collection('items_to_remove');
    await itemsCollection.initPromise;
    await itemsCollection.clear();

    const item1 = await itemsCollection.insert({ name: 'Элемент 1' });
    await itemsCollection.insert({ name: 'Элемент 2' });

    console.log(`Количество элементов до удаления: ${await itemsCollection.count()}`); // 2

    // Удаляем Элемент 1
    const removeResult = await itemsCollection.remove(item1._id);
    console.log(`Результат удаления элемента с ID ${item1._id}: ${removeResult}`); // true

    console.log(`Количество элементов после удаления: ${await itemsCollection.count()}`); // 1

    // Попытка удалить несуществующий элемент
    const nonExistentRemove = await itemsCollection.remove('non-existent-id');
    console.log(`Результат удаления несуществующего элемента: ${nonExistentRemove}`); // false

  } catch (error) {
    console.error('Ошибка при удалении документа:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

removeSingleDocument();
```

### Как удалить несколько документов по условию (`removeMany`)

Метод `collection.removeMany(predicate)` удаляет все документы, соответствующие функции-предикату.

*   **Параметры:**
    *   `predicate {function}`: Синхронная функция, которая принимает объект документа и возвращает `true` (удалить) или `false` (оставить).
*   **Возвращает:** `Promise<number>` - Промис, который разрешается числом — количеством успешно удаленных документов.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function removeMultipleDocuments() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const tasksCollection = await db.collection('tasks_for_removal');
    await tasksCollection.initPromise;
    await tasksCollection.clear();

    await tasksCollection.insertMany([
      { description: 'Задача 1', status: 'completed', priority: 1 },
      { description: 'Задача 2', status: 'pending', priority: 2 },
      { description: 'Задача 3', status: 'completed', priority: 3 },
      { description: 'Задача 4', status: 'in-progress', priority: 1 },
      { description: 'Задача 5', status: 'completed', priority: 2 },
    ]);
    console.log(`Всего задач до удаления: ${await tasksCollection.count()}`); // 5

    // Удалим все выполненные задачи ('completed')
    const predicate = (doc) => doc.status === 'completed';
    const removedCount = await tasksCollection.removeMany(predicate);

    console.log(`Удалено ${removedCount} выполненных задач.`); // Ожидаем 3
    console.log(`Всего задач после удаления: ${await tasksCollection.count()}`); // Ожидаем 2

    const remainingTasks = await tasksCollection.getAll();
    console.log('Оставшиеся задачи:');
    remainingTasks.forEach(task => console.log(task.description, task.status));

  } catch (error) {
    console.error('Ошибка при пакетном удалении документов:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

removeMultipleDocuments();
```

### Как удалить все документы из коллекции (`clear`)

Метод `collection.clear()` удаляет **все** документы из коллекции.

*   **Параметры:** Нет.
*   **Возвращает:** `Promise<boolean>` - Промис, который разрешается `true`, если операция очистки прошла успешно. (Обычно всегда `true`, если не возникло внутренних ошибок).

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function clearWholeCollection() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const logsCollection = await db.collection('logs_to_clear');
    await logsCollection.initPromise;

    await logsCollection.insertMany([
      { level: 'info', message: 'Log 1' },
      { level: 'error', message: 'Log 2' },
    ]);
    console.log(`Количество логов до очистки: ${await logsCollection.count()}`); // 2

    const clearResult = await logsCollection.clear();
    console.log(`Результат очистки коллекции: ${clearResult}`); // true

    console.log(`Количество логов после очистки: ${await logsCollection.count()}`); // 0

  } catch (error) {
    console.error('Ошибка при очистке коллекции:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

clearWholeCollection();
```

## Подсчет Документов

### Как посчитать количество документов в коллекции (`count`)

Метод `collection.count()` возвращает количество "живых" (не истекших по TTL) документов в коллекции.

*   **Параметры:** Нет.
*   **Возвращает:** `Promise<number>` - Промис, который разрешается числом документов.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function countDocumentsInCollection() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const itemsCollection = await db.collection('items_for_counting');
    await itemsCollection.initPromise;
    await itemsCollection.clear(); // Начинаем с чистой коллекции

    const initialCount = await itemsCollection.count();
    console.log(`Начальное количество элементов: ${initialCount}`); // 0

    await itemsCollection.insertMany([
      { name: 'Предмет A' },
      { name: 'Предмет B', ttl: 1000 }, // Этот истечет, если подождать
      { name: 'Предмет C' },
    ]);

    const countAfterInsert = await itemsCollection.count();
    console.log(`Количество элементов после вставки: ${countAfterInsert}`); // 3

    // Для демонстрации TTL и count:
    // Если вы хотите увидеть, как count учитывает TTL,
    // вам нужно будет подождать истечения TTL и, возможно,
    // явно вызвать cleanupExpiredDocs или положиться на автоматическую очистку,
    // которая также может быть вызвана некоторыми операциями чтения, включая count.
    // await new Promise(r => setTimeout(r, 1500)); // Ждем > 1 секунды
    // const countAfterTTLWait = await itemsCollection.count();
    // console.log(`Количество элементов после ожидания TTL: ${countAfterTTLWait}`); // Ожидаемо 2

  } catch (error) {
    console.error('Ошибка при подсчете документов:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

countDocumentsInCollection();
```
В следующем разделе мы рассмотрим, как эффективно искать документы с использованием различных методов запросов и индексов.