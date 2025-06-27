```markdown
# 01 - Работа с Коллекциями и Документами

В этом разделе подробно рассматриваются основные операции по управлению данными (CRUD - Create, Read, Update, Delete) в коллекциях WiseJSON DB, а также установка времени жизни (TTL) для документов.

**Предполагается, что у вас уже есть инициализированный экземпляр `db` и получен экземпляр `collection`, как описано в разделе `00-introduction-and-setup.md`.**

## Добавление Документов (Create)

### Как добавить один документ (`insert`)

Метод `collection.insert(document)` используется для добавления одного нового документа в коллекцию.

*   **Параметры:**
    *   `document {object}`: JavaScript-объект, который вы хотите сохранить.
        *   Если вы предоставите поле `_id` в объекте `document`, оно будет использовано как уникальный идентификатор.
        *   Если поле `_id` не предоставлено, WiseJSON DB автоматически сгенерирует уникальный `_id` (согласно опции `idGenerator`).
*   **Возвращает:** `Promise<object>` - Промис, который разрешается объектом вставленного документа. Этот объект будет содержать поля `_id`, `createdAt` (время создания в формате ISO-строки) и `updatedAt` (время последнего обновления, изначально совпадает с `createdAt`).
*   **Ошибки:** Может выбросить ошибку, если, например, нарушается уникальность индекса.

**Пример:**

```javascript
// Добавляем новый документ с авто-ID
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
//   _id: 'сгенерированный_id',
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
```

### Как добавить несколько документов сразу (`insertMany`)

Метод `collection.insertMany(documentsArray)` позволяет эффективно добавить массив документов за одну операцию.

*   **Параметры:**
    *   `documentsArray {Array<object>}`: Массив JavaScript-объектов для вставки.
*   **Возвращает:** `Promise<Array<object>>` - Промис, который разрешается массивом вставленных документов, каждый из которых будет содержать `_id`, `createdAt` и `updatedAt`.
*   **Поведение при ошибках:** Если при обработке возникает ошибка (например, нарушение уникального индекса), операция прерывается, и будет выброшена ошибка. Документы до проблемного могут быть уже вставлены.

**Пример:**

```javascript
const newProducts = [
  { name: 'Ноутбук', category: 'Электроника', price: 1200 },
  { name: 'Смартфон', category: 'Электроника', price: 800 },
  { _id: 'book-451', name: 'Книга "451 градус по Фаренгейту"', category: 'Книги', price: 15 }
];

const insertedProducts = await productsCollection.insertMany(newProducts);
console.log(`Успешно добавлено ${insertedProducts.length} продуктов.`);
```

### Как добавить документ с ограниченным временем жизни (TTL)

WiseJSON DB позволяет устанавливать время жизни для документов, после истечения которого они будут автоматически удалены. Это делается с помощью полей `ttl` или `expireAt` в самом документе.

*   **`ttl {number}`**: Время жизни документа в миллисекундах с момента его создания (поле `createdAt`).
*   **`expireAt {number | string}`**: Точное время (Unix timestamp в миллисекундах или строка в формате ISO 8601), когда документ должен истечь и быть удален.

Если указаны оба поля, приоритет будет у `expireAt`. Очистка устаревших документов происходит периодически.

**Пример:**

```javascript
// Документ, который "умрет" через 10 секунд после создания
await tempCollection.insert({
  message: 'Это сообщение исчезнет через 10 секунд.',
  ttl: 10000 // 10 секунд
});

// Документ, который "умрет" в определенное время
await tempCollection.insert({
  data: 'Информация, актуальная 1 минуту.',
  expireAt: Date.now() + 60000 // Через 60 секунд
});
```

## Чтение Документов (Read)

Описание операций чтения (`getById`, `find`, `findOne`), использующих мощные фильтры и индексы, находится в следующем разделе: **`02-querying-and-indexing.md`**.

## Обновление Документов (Update)

WiseJSON DB предлагает несколько методов для обновления документов.

### Как обновить один документ по ID (`update`)

Метод `collection.update(id, updates)` позволяет частично обновить поля существующего документа. Поля, присутствующие в `updates`, будут изменены или добавлены, а отсутствующие — останутся без изменений.

*   **Параметры:**
    *   `id {string}`: Уникальный `_id` документа для обновления.
    *   `updates {object}`: Объект, содержащий поля и их новые значения.
*   **Возвращает:** `Promise<object | null>` - Промис, который разрешается обновленным объектом документа, или `null`, если документ не найден.
*   **Важно:** Этот метод не может изменить `_id` или `createdAt`. Поле `updatedAt` будет обновлено автоматически.

**Пример:**

```javascript
const userToUpdate = await usersCollection.findOne({ email: 'alice@example.com' });
if (userToUpdate) {
  const updatedUser = await usersCollection.update(userToUpdate._id, {
    age: 31,
    status: 'active' // Добавляем новое поле
  });
  console.log('Пользователь после обновления:', updatedUser);
}
```

### Продвинутое обновление с фильтрами и операторами

Для более сложных обновлений используются методы, принимающие **фильтр** для поиска документов и **операторы обновления**, аналогичные MongoDB.

**Основные операторы обновления:**
*   `$set`: Устанавливает значение поля.
*   `$inc`: Увеличивает (или уменьшает) числовое поле.
*   `$unset`: Удаляет поле из документа.
*   `$push`: Добавляет элемент в массив.

#### Обновление одного документа по фильтру (`updateOne`)

Метод `collection.updateOne(filter, update)` находит **первый** документ, соответствующий `filter`, и применяет к нему изменения, описанные в `update`.

*   **Параметры:**
    *   `filter {object}`: Объект-фильтр для поиска (синтаксис как в `find`).
    *   `update {object}`: Объект с операторами обновления.
*   **Возвращает:** `Promise<{ matchedCount: number, modifiedCount: number }>`
    *   `matchedCount`: Количество найденных документов (0 или 1).
    *   `modifiedCount`: Количество реально измененных документов (0 или 1).

**Пример:**

```javascript
// Увеличить возраст пользователя 'Alice' на 1 и установить ей новый статус
const filter = { email: 'alice@example.com' };
const update = {
  $inc: { age: 1 },
  $set: { lastSeen: new Date().toISOString() }
};

const result = await usersCollection.updateOne(filter, update);
console.log(`Найдено для обновления: ${result.matchedCount}, изменено: ${result.modifiedCount}`);
```

#### Обновление нескольких документов по фильтру (`updateMany`)

Метод `collection.updateMany(filter, update)` применяет изменения ко **всем** документам, которые соответствуют `filter`.

*   **Параметры:** Аналогичны `updateOne`.
*   **Возвращает:** `Promise<{ matchedCount: number, modifiedCount: number }>`

**Пример:**

```javascript
// Дать скидку 10% на все книги в наличии
const filter = { category: 'Книги', stock: { $gt: 0 } };
const update = { $set: { onSale: true, discount: 0.1 } };

const result = await productsCollection.updateMany(filter, update);
console.log(`Найдено товаров для скидки: ${result.matchedCount}, обновлено: ${result.modifiedCount}`);
```

#### Найти и обновить атомарно (`findOneAndUpdate`)

Этот метод находит один документ, обновляет его и возвращает. Идеально подходит для сценариев, где нужно получить документ в его старом или новом состоянии сразу после изменения (например, для счетчиков).

*   **Параметры:**
    *   `filter {object}`: Фильтр для поиска.
    *   `update {object}`: Объект с операторами обновления.
    *   `options.returnOriginal {boolean}`: Если `false` (по умолчанию), возвращает документ **после** обновления. Если `true`, возвращает документ **до** обновления.
*   **Возвращает:** `Promise<object | null>` - Документ (до или после обновления) или `null`, если ничего не найдено.

**Пример:**

```javascript
// Зарезервировать один товар и вернуть его состояние *до* резервации
const filter = { name: 'Ноутбук', stock: { $gt: 0 } };
const update = { $inc: { stock: -1 } };
const options = { returnOriginal: true };

const originalProductState = await productsCollection.findOneAndUpdate(filter, update, options);

if (originalProductState) {
  console.log(`Товар успешно зарезервирован. Остаток на складе был: ${originalProductState.stock}`);
}
```

## Удаление Документов (Delete)

### Как удалить один документ по ID (`remove`)

Метод `collection.remove(id)` удаляет один документ из коллекции по его `_id`.

*   **Параметры:**
    *   `id {string}`: Уникальный `_id` документа для удаления.
*   **Возвращает:** `Promise<boolean>` - `true`, если документ был найден и удален, иначе `false`.

**Пример:**

```javascript
const wasRemoved = await itemsCollection.remove('some-item-id');
console.log(`Документ был удален: ${wasRemoved}`);
```

### Продвинутое удаление с фильтрами

#### Удаление одного документа по фильтру (`deleteOne`)

Метод `collection.deleteOne(filter)` удаляет **первый** документ, соответствующий `filter`.

*   **Параметры:**
    *   `filter {object}`: Фильтр для поиска документа на удаление.
*   **Возвращает:** `Promise<{ deletedCount: number }>` - Объект, где `deletedCount` равен 0 или 1.

**Пример:**

```javascript
// Удалить один неактивный лог
const result = await logsCollection.deleteOne({ level: 'debug', processed: true });
console.log(`Удалено логов: ${result.deletedCount}`);
```

#### Удаление нескольких документов по фильтру (`deleteMany`)

Метод `collection.deleteMany(filter)` удаляет **все** документы, соответствующие `filter`.

*   **Параметры:**
    *   `filter {object}`: Фильтр для поиска документов на удаление.
*   **Возвращает:** `Promise<{ deletedCount: number }>` - Объект с количеством удаленных документов.

**Пример:**

```javascript
// Удалить все сессии пользователя, которые истекли
const filter = {
  userId: 'user-123',
  expiresAt: { $lt: new Date().toISOString() }
};

const result = await sessionsCollection.deleteMany(filter);
console.log(`Удалено устаревших сессий: ${result.deletedCount}`);
```

### Как удалить все документы из коллекции (`clear`)

Метод `collection.clear()` удаляет **все** документы из коллекции. Используйте с осторожностью.

*   **Параметры:** Нет.
*   **Возвращает:** `Promise<boolean>` - Промис, который разрешается `true` при успешной очистке.

**Пример:**

```javascript
const clearResult = await logsCollection.clear();
console.log(`Результат очистки коллекции: ${clearResult}`);
```

## Подсчет Документов (`count`)

Метод `collection.count()` возвращает количество "живых" (не истекших по TTL) документов в коллекции.

*   **Параметры:** Нет.
*   **Возвращает:** `Promise<number>` - Промис, который разрешается числом документов.

**Пример:**

```javascript
const totalUsers = await usersCollection.count();
console.log(`Всего пользователей в системе: ${totalUsers}`);
```
В следующем разделе мы подробно рассмотрим, как эффективно искать и фильтровать документы с помощью `find`, `findOne` и индексов.