```markdown
docs/02-querying-and-indexing.md
# 02 - Запросы к Данным и Индексирование

Этот раздел посвящен тому, как извлекать документы из коллекций WiseJSON DB и как использовать индексы для ускорения этих операций.

**Предполагается, что у вас уже есть инициализированный экземпляр `WiseJSON` (переменная `db`) и получен экземпляр коллекции с дождавшимся `initPromise` (переменная `collection`), как описано в разделе `00-introduction-and-setup.md`.**

## Чтение Документов

### Как получить документ по его ID (`getById`)

Метод `collection.getById(id)` позволяет получить один конкретный документ, если вы знаете его уникальный идентификатор `_id`.

*   **Параметры:**
    *   `id {string}`: Уникальный `_id` искомого документа.
*   **Возвращает:** `Promise<object | null>` - Промис, который разрешается объектом найденного документа. Если документ с таким `id` не существует или его срок жизни (TTL) истек, промис разрешается значением `null`.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function getDocumentByIdExample() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const articlesCollection = await db.collection('articles');
    await articlesCollection.initPromise;
    await articlesCollection.clear(); // Начнем с чистой коллекции

    const article1 = await articlesCollection.insert({ title: 'Статья о Node.js', tags: ['nodejs', 'javascript'] });
    const article2 = await articlesCollection.insert({ title: 'Статья о Базах Данных', tags: ['db', 'storage'] });

    // Получаем статью по ID
    const foundArticle = await articlesCollection.getById(article1._id);
    if (foundArticle) {
      console.log('Найдена статья по ID:', foundArticle);
    } else {
      console.log(`Статья с ID ${article1._id} не найдена.`);
    }

    // Попытка получить несуществующую статью
    const nonExistentArticle = await articlesCollection.getById('non-existent-article-id');
    console.log('Результат поиска несуществующей статьи:', nonExistentArticle); // Выведет: null

  } catch (error) {
    console.error('Ошибка при получении документа по ID:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

getDocumentByIdExample();
```

### Как получить все документы из коллекции (`getAll`)

Метод `collection.getAll()` извлекает все "живые" (не истекшие по TTL) документы из коллекции.

*   **Параметры:** Нет.
*   **Возвращает:** `Promise<Array<object>>` - Промис, который разрешается массивом всех найденных документов. Если коллекция пуста или все документы истекли, возвращается пустой массив.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function getAllDocumentsExample() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const tasksCollection = await db.collection('tasks_get_all');
    await tasksCollection.initPromise;
    await tasksCollection.clear();

    await tasksCollection.insertMany([
      { description: 'Купить молоко', done: false },
      { description: 'Написать код', done: true },
      { description: 'Позвонить другу', done: false, ttl: 1000 } // Может истечь к моменту getAll
    ]);

    // Для демонстрации TTL с getAll
    // console.log('Ожидание для истечения TTL...');
    // await new Promise(r => setTimeout(r, 1500));

    const allTasks = await tasksCollection.getAll();
    console.log(`Найдено ${allTasks.length} задач:`);
    allTasks.forEach(task => console.log(`- ${task.description} (Готово: ${task.done})`));

  } catch (error) {
    console.error('Ошибка при получении всех документов:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

getAllDocumentsExample();
```

### Как найти документы по условию (`find`)

Метод `collection.find(predicate)` позволяет найти все документы, которые удовлетворяют определенному условию. Условие задается функцией-предикатом.

*   **Параметры:**
    *   `predicate {function}`: Синхронная функция, которая вызывается для каждого "живого" документа в коллекции. Она принимает один аргумент — объект документа. Если функция возвращает `true`, документ включается в результаты поиска.
*   **Возвращает:** `Promise<Array<object>>` - Промис, который разрешается массивом документов, для которых предикат вернул `true`.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function findDocumentsByCondition() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const usersCollection = await db.collection('users_find');
    await usersCollection.initPromise;
    await usersCollection.clear();

    await usersCollection.insertMany([
      { name: 'Alice', age: 30, city: 'New York', active: true },
      { name: 'Bob', age: 24, city: 'London', active: false },
      { name: 'Charlie', age: 35, city: 'New York', active: true },
      { name: 'David', age: 22, city: 'Paris', active: true },
    ]);

    // Найти всех пользователей старше 25 лет
    const usersOver25 = await usersCollection.find(user => user.age > 25);
    console.log('Пользователи старше 25 лет:');
    usersOver25.forEach(u => console.log(u.name, u.age));

    // Найти всех активных пользователей из Нью-Йорка
    const activeNewYorkers = await usersCollection.find(
      user => user.active === true && user.city === 'New York'
    );
    console.log('\nАктивные пользователи из Нью-Йорка:');
    activeNewYorkers.forEach(u => console.log(u.name, u.city));

  } catch (error) {
    console.error('Ошибка при поиске документов по условию:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

findDocumentsByCondition();
```

### Как найти один документ по условию (`findOne`)

Метод `collection.findOne(predicate)` работает аналогично `find`, но возвращает только первый найденный документ, удовлетворяющий условию, или `null`, если ни один документ не найден.

*   **Параметры:**
    *   `predicate {function}`: Такая же функция-предикат, как и для `find`.
*   **Возвращает:** `Promise<object | null>` - Промис, который разрешается первым найденным объектом документа или `null`.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function findOneDocumentByCondition() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const productsCollection = await db.collection('products_findone');
    await productsCollection.initPromise;
    await productsCollection.clear();

    await productsCollection.insertMany([
      { name: 'Ноутбук X1', category: 'Электроника', price: 1200, inStock: true },
      { name: 'Мышь Y2', category: 'Аксессуары', price: 25, inStock: true },
      { name: 'Клавиатура Z3', category: 'Аксессуары', price: 70, inStock: false },
      { name: 'Монитор A7', category: 'Электроника', price: 300, inStock: true },
    ]);

    // Найти первый продукт из категории "Электроника" в наличии
    const firstElectronicInStock = await productsCollection.findOne(
      product => product.category === 'Электроника' && product.inStock === true
    );

    if (firstElectronicInStock) {
      console.log('Найден первый продукт "Электроника" в наличии:', firstElectronicInStock);
    } else {
      console.log('Продукты "Электроника" в наличии не найдены.');
    }

    // Найти продукт с ценой больше 2000 (таких нет)
    const expensiveProduct = await productsCollection.findOne(product => product.price > 2000);
    console.log('Результат поиска очень дорогого продукта:', expensiveProduct); // Выведет: null

  } catch (error) {
    console.error('Ошибка при поиске одного документа по условию:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

findOneDocumentByCondition();
```

## Ускорение Поиска с Помощью Индексов

### Зачем нужны индексы?

Индексы в базе данных служат для ускорения операций поиска. Когда вы часто ищете документы по определенным полям, создание индекса по этим полям может значительно повысить производительность, особенно на больших коллекциях. Вместо полного перебора всех документов (full scan), база данных сможет быстро находить нужные документы, используя структуру индекса.

WiseJSON DB поддерживает два типа индексов:
*   **Стандартные (неуникальные) индексы**: Позволяют иметь несколько документов с одинаковым значением в индексированном поле.
*   **Уникальные индексы**: Гарантируют, что каждое значение в индексированном поле будет уникальным для всей коллекции. Попытка вставить или обновить документ так, что это приведет к дублированию значения в уникальном индексе, вызовет ошибку.

### Как создать индекс (`createIndex`)

Метод `collection.createIndex(fieldName, options)` создает индекс для указанного поля.

*   **Параметры:**
    *   `fieldName {string}`: Имя поля документа, по которому будет создан индекс.
    *   `options {object}` (опционально): Объект с опциями индекса.
        *   `options.unique {boolean}`: Если `true`, создается уникальный индекс. По умолчанию `false` (создается стандартный, неуникальный индекс).
*   **Возвращает:** `Promise<void>` - Промис, который разрешается после успешного создания индекса.
*   **Поведение:**
    *   Индекс создается один раз. Повторный вызов `createIndex` для того же поля с теми же опциями не приведет к ошибке, но и не создаст дубликат индекса.
    *   Если вы попытаетесь создать уникальный индекс на поле, которое уже содержит дублирующиеся значения, WiseJSON DB **не выбросит ошибку на этапе создания индекса**. Однако, при последующих операциях вставки или обновления, которые нарушают уникальность, будет выброшена ошибка. При первой загрузке или перестроении индекса (например, после восстановления из чекпоинта) может быть выдано предупреждение о дубликатах для уникального индекса, но сам индекс будет построен (сохранив только одну ссылку на дублирующееся значение).

    *   Однако, если вы попытаетесь создать индекс с именем, которое уже используется существующим индексом, но с другим типом уникальности (например, изменить существующий стандартный индекс на уникальный или наоборот), будет выброшена ошибка. В этом случае необходимо сначала удалить старый индекс с помощью dropIndex, а затем создать новый с нужными опциями.

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function createIndexesExample() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const customersCollection = await db.collection('customers');
    await customersCollection.initPromise;
    await customersCollection.clear();

    // Добавим несколько клиентов
    await customersCollection.insertMany([
      { name: 'Иван Петров', email: 'ivan@example.com', city: 'Москва' },
      { name: 'Мария Сидорова', email: 'maria@example.com', city: 'Санкт-Петербург' },
      { name: 'Петр Иванов', email: 'petr@example.com', city: 'Москва' },
    ]);

    // Создаем стандартный (неуникальный) индекс по полю 'city'
    await customersCollection.createIndex('city');
    console.log("Индекс по полю 'city' успешно создан.");

    // Создаем уникальный индекс по полю 'email'
    await customersCollection.createIndex('email', { unique: true });
    console.log("Уникальный индекс по полю 'email' успешно создан.");

    // Попытка добавить клиента с существующим email (должна вызвать ошибку)
    try {
      await customersCollection.insert({ name: 'Анна Кузнецова', email: 'ivan@example.com', city: 'Казань' });
    } catch (e) {
      console.error(`\nОжидаемая ошибка при вставке дублирующего email: ${e.message}`);
    }

  } catch (error) {
    console.error('Ошибка в примере с созданием индексов:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

createIndexesExample();
```

### Как искать документы с использованием индекса

После создания индекса вы можете использовать специальные методы для быстрого поиска:

*   **`collection.findByIndexedValue(fieldName, value)`**: Находит все документы, у которых значение в индексированном поле `fieldName` равно `value`. Подходит для стандартных (неуникальных) индексов.
*   **`collection.findOneByIndexedValue(fieldName, value)`**: Находит один документ (или `null`), у которого значение в индексированном поле `fieldName` равно `value`. Особенно эффективен для полей с уникальным индексом.

*   **Параметры:**
    *   `fieldName {string}`: Имя индексированного поля.
    *   `value {any}`: Значение, по которому осуществляется поиск.
*   **Возвращает:**
    *   `findByIndexedValue`: `Promise<Array<object>>`
    *   `findOneByIndexedValue`: `Promise<object | null>`

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function findByIndexesExample() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const customersCollection = await db.collection('customers'); // Используем коллекцию из предыдущего примера
    await customersCollection.initPromise;

    // Предполагаем, что индексы по 'city' и 'email' уже созданы

    // Поиск по неуникальному индексу 'city'
    const moscowCustomers = await customersCollection.findByIndexedValue('city', 'Москва');
    console.log('\nКлиенты из Москвы (поиск по индексу city):');
    moscowCustomers.forEach(c => console.log(c.name, c.email));

    // Поиск по уникальному индексу 'email'
    const maria = await customersCollection.findOneByIndexedValue('email', 'maria@example.com');
    if (maria) {
      console.log('\nНайден клиент Maria по email (поиск по уникальному индексу email):', maria);
    } else {
      console.log('\nКлиент Maria не найден по email.');
    }

    // Поиск по несуществующему значению в индексе
    const nonExistentEmail = await customersCollection.findOneByIndexedValue('email', 'ghost@example.com');
    console.log('\nРезультат поиска по несуществующему email:', nonExistentEmail); // null

    // Поиск по полю без индекса (будет работать как обычный find, перебирая документы)
    // Например, если бы мы не создали индекс по 'name'
    console.log('\nПоиск по полю "name" (без индекса, будет полный перебор):');
    const ivanPetrovByName = await customersCollection.find(c => c.name === 'Иван Петров');
    ivanPetrovByName.forEach(c => console.log(c));


  } catch (error) {
    console.error('Ошибка в примере с поиском по индексам:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

// Запустите createIndexesExample() перед этим, чтобы коллекция и индексы были созданы.
// findByIndexesExample();
```
**Примечание:** Для запуска `findByIndexesExample` убедитесь, что коллекция `customers` и индексы по `city` и `email` были созданы (например, предварительным запуском `createIndexesExample`).

### Как посмотреть существующие индексы (`getIndexes`)

Метод `collection.getIndexes()` возвращает информацию о всех индексах, созданных для данной коллекции.

*   **Параметры:** Нет.
*   **Возвращает:** `Promise<Array<{fieldName: string, type: string}>>` - Промис, который разрешается массивом объектов. Каждый объект описывает один индекс и содержит:
    *   `fieldName {string}`: Имя индексированного поля.
    *   `type {string}`: Тип индекса (`'standard'` или `'unique'`).

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function listIndexesExample() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const customersCollection = await db.collection('customers'); // Используем коллекцию из предыдущих примеров
    await customersCollection.initPromise;

    // Предполагаем, что индексы по 'city' и 'email' уже созданы

    const indexes = await customersCollection.getIndexes();
    console.log('\nСуществующие индексы для коллекции "customers":', indexes);
    // Пример вывода:
    // [
    //   { fieldName: 'city', type: 'standard' },
    //   { fieldName: 'email', type: 'unique' }
    // ]

  } catch (error) {
    console.error('Ошибка при получении списка индексов:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

// listIndexesExample();
```

### Как удалить индекс (`dropIndex`)

Метод `collection.dropIndex(fieldName)` удаляет существующий индекс по указанному полю.

*   **Параметры:**
    *   `fieldName {string}`: Имя поля, индекс для которого нужно удалить.
*   **Возвращает:** `Promise<void>` - Промис, который разрешается после успешного удаления индекса.
*   **Поведение:** Если индекс для указанного поля не существует, метод ничего не сделает и не вызовет ошибку" также полностью соответствует обновленной логике (где теперь выводится WARN, а не ошибка).

**Пример:**

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function dropIndexExample() {
  const dbPath = path.resolve(__dirname, 'myAppDb');
  let db;
  try {
    db = new WiseJSON(dbPath);
    await db.init();
    const customersCollection = await db.collection('customers'); // Используем коллекцию
    await customersCollection.initPromise;

    // Предположим, индекс по 'city' существует
    console.log('\nИндексы до удаления:', await customersCollection.getIndexes());

    await customersCollection.dropIndex('city');
    console.log("Индекс по полю 'city' удален.");

    console.log('Индексы после удаления "city":', await customersCollection.getIndexes());

    // Попытка удалить несуществующий индекс
    await customersCollection.dropIndex('non_existent_field_for_index');
    console.log('Попытка удалить несуществующий индекс не вызвала ошибок.');
    console.log('Индексы после попытки удаления несуществующего:', await customersCollection.getIndexes());


  } catch (error) {
    console.error('Ошибка в примере с удалением индекса:', error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

// dropIndexExample();
```

### Обновление нескольких документов

Метод `updateMany(predicate, update)` позволяет обновить все документы, удовлетворяющие условию.  
Второй аргумент должен быть **объектом**, описывающим изменения.

```js
await collection.updateMany(
  doc => doc.status === 'new',
  { status: 'processed' } // ✅ объект, а не функция
);
```

Использование индексов — важный аспект оптимизации производительности при работе с WiseJSON DB, особенно для коллекций с большим количеством документов и частыми операциями поиска.