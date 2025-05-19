# WiseJSON

WiseJSON - это легковесная встраиваемая база данных на основе JSON-файлов, созданная на чистом JavaScript для среды Node.js.
Она ориентирована на проекты, где требуется простое, но надежное локальное хранилище данных без необходимости установки, настройки и администрирования внешних СУБД.
Ключевыми принципами WiseJSON являются надежность операций, предсказуемость поведения и простота использования API.

## Основные возможности

*   **Хранение данных в JSON-файлах:** Данные организованы в именованные коллекции. Каждая коллекция физически представляет собой директорию, содержащую один или несколько файлов-сегментов в формате JSON.
*   **Автоматическая сегментация файлов:** Для эффективной работы с большими объемами данных, WiseJSON автоматически разделяет данные коллекции на более мелкие файлы-сегменты. Новый сегмент создается, когда размер текущего сегмента достигает предварительно настроенного лимита.
*   **Надежные операции записи:** Операции изменения данных (`insert`, `update`, `remove`, `upsert`, `clear`) используют стратегию записи во временный файл (`.new`) с последующим созданием резервной копии (`.bak`) и атомарным (на большинстве файловых систем) переименованием. Это значительно снижает риск повреждения данных при сбоях. При инициализации происходит проверка и автоматическое восстановление из `.bak` или `.new` файлов, если это необходимо.
*   **Последовательное выполнение операций записи:** В рамках одной коллекции операции изменения данных выполняются последовательно через внутреннюю очередь, что предотвращает гонки состояний и обеспечивает консистентность данных на уровне коллекции.
*   **Гибкий асинхронный API:** Предоставляет интуитивно понятные асинхронные методы (возвращающие промисы) для всех стандартных CRUD-операций, а также для подсчета документов (`count`), условной вставки/обновления (`upsert`), получения статистики коллекции (`getCollectionStats`) и полной очистки коллекции (`clear`).
*   **Минимальные зависимости:** WiseJSON написана на чистом JavaScript и использует только встроенные модули Node.js (`fs/promises`, `path`) и `uuid` для генерации уникальных идентификаторов документов.
*   **Настраиваемость:** Позволяет пользователю конфигурировать ключевые параметры, такие как путь к хранилищу данных, максимальный размер файла-сегмента, форматирование JSON-файлов и даже функцию для генерации ID документов.
*   **Система хуков (событий):** Предоставляет простой механизм для подписки на события жизненного цикла документов (`afterInsert`, `afterUpdate`, `afterRemove`), позволяя расширять функциональность приложения без модификации ядра библиотеки.

## Установка

1.  **Скопируйте библиотеку:**
    Поместите директорию `wise-json` (которая содержит файлы `index.js` и `collection.js`) в структуру вашего проекта. Например, в папку `lib/wise-json/` или непосредственно в корень проекта.
    *Примечание: WiseJSON на данный момент не распространяется как npm-пакет, а предназначена для прямого включения в проект.*

2.  **Установите зависимость `uuid`:**
    Если она еще не установлена в вашем проекте, выполните:
    ```bash
    npm install uuid
    ```
    или если вы используете yarn:
    ```bash
    yarn add uuid
    ```

## Использование

### 1. Инициализация WiseJSON

```javascript
const WiseJSON = require('./path/to/wise-json'); // Укажите корректный путь к wise-json/index.js
const path = require('path');

// Определите путь к КОРНЕВОЙ ДИРЕКТОРИИ, где WiseJSON будет хранить все свои данные.
// WiseJSON автоматически создаст эту директорию, если она не существует.
// Рекомендуется использовать абсолютный путь или путь, вычисляемый относительно
// вашего приложения (например, с помощью path.resolve(__dirname, 'data-storage')).
const dbStoragePath = path.resolve(__dirname, 'application_database'); // Пример

// Глобальные опции (необязательно):
const globalOptions = {
    maxSegmentSizeBytes: 512 * 1024, // Максимальный размер сегмента 512KB (по умолчанию 1MB).
    jsonIndent: 2,                   // Форматировать JSON с отступом в 2 пробела (по умолчанию 2).
                                     // Установите null или 0 для компактного JSON без отступов.
    // idGenerator: () => `my-prefix-${Date.now()}` // Пример кастомного генератора ID
};

const db = new WiseJSON(dbStoragePath, globalOptions);

// Инициализация базовой директории асинхронна.
// Рекомендуется дождаться ее завершения перед активными операциями.
db.baseDirInitPromise
    .then(() => {
      console.log('WiseJSON: Хранилище данных готово к использованию.');
      // Запуск основной логики вашего приложения
      startApplication();
    })
    .catch(initializationError => {
      console.error('WiseJSON: КРИТИЧЕСКАЯ ОШИБКА при инициализации хранилища. Приложение не может стартовать.', initializationError);
        process.exit(1); // Завершение приложения при критической ошибке инициализации
    });
    
async function startApplication() {
    // Пример дальнейшей работы:
    // await manageProducts().catch(console.error);
    // await displayCollectionStats().catch(console.error);
    // await clearUserCollection().catch(console.error);
}
```

### 2. Работа с Коллекциями

Данные в WiseJSON организуются в коллекции. Каждая коллекция управляется отдельным экземпляром класса `Collection`.

```javascript
async function manageProducts() {
    try {
        // Получение (или создание при первом обращении) коллекции 'products'.
        // Опции, переданные здесь, переопределят глобальные опции для этой коллекции.
        const productsCollection = await db.collection('products', {
            maxSegmentSizeBytes: 256 * 1024 // Сегменты для товаров будут не более 256KB
        });

        // Теперь можно работать с productsCollection...
        const allProds = await productsCollection.getAll();
        console.log('Все продукты:', allProds.length);
        
    } catch (error) {
        console.error('Ошибка при получении или работе с коллекцией "products":', error);
    }
}
```

### 3. API Коллекции (`Collection`)

Все методы экземпляра `Collection` асинхронны и возвращают `Promise`.

#### `async collection.insert(dataObject)`

Вставляет новый документ.
*   `dataObject` (object): Данные для нового документа. Поля `_id`, `createdAt`, `updatedAt` будут автоматически сгенерированы/перезаписаны.
*   Возвращает: `Promise<object>` - вставленный документ.

```javascript
const newProduct = await productsCollection.insert({
    name: 'Умные часы Series X',
    brand: 'TechCorp',
    price: 12990
});
console.log('Новый продукт:', newProduct);
```

#### `async collection.getById(id)`

Находит документ по `_id`.
*   `id` (string): Уникальный идентификатор.
*   Возвращает: `Promise<object|null>` - найденный документ или `null`.

```javascript
const product = await productsCollection.getById(newProduct._id);
if (product) {
    console.log('Найденный продукт:', product);
} else {
    console.log('Продукт не найден.');
}
```

#### `async collection.find(queryFunction)`

Находит все документы, удовлетворяющие `queryFunction`.
*   `queryFunction` (function): `(document) => boolean`.
*   Возвращает: `Promise<object[]>` - массив найденных документов.

```javascript
const techCorpProducts = await productsCollection.find(
    item => item.brand === 'TechCorp' && item.price < 15000
);
console.log('Продукты TechCorp дешевле 15000:', techCorpProducts);
```

#### `async collection.findOne(queryFunction)`

Находит первый документ, удовлетворяющий `queryFunction`.
*   `queryFunction` (function): `(document) => boolean`.
*   Возвращает: `Promise<object|null>` - найденный документ или `null`.

```javascript
const firstInStock = await productsCollection.findOne(item => item.stock > 0);
if (firstInStock) {
    console.log('Первый товар в наличии:', firstInStock);
}
```

#### `async collection.getAll()`

Получает все документы из коллекции.
*   Возвращает: `Promise<object[]>` - массив всех документов.

```javascript
const allItems = await productsCollection.getAll();
console.log('Всего элементов в коллекции:', allItems.length);
```

#### `async collection.update(id, updatesObject)`

Обновляет документ с указанным `_id`.
*   `id` (string): `_id` документа.
*   `updatesObject` (object): Поля для обновления. `_id` и `createdAt` не изменяются. `updatedAt` обновляется.
*   Возвращает: `Promise<object|null>` - обновленный документ или `null`.

```javascript
const updatedProduct = await productsCollection.update(newProduct._id, {
    price: 12500,
    stock: 70
});
if (updatedProduct) {
    console.log('Обновленный продукт:', updatedProduct);
}
// Примечание: для сложных обновлений массивов (например, добавление/удаление элементов)
// рекомендуется сначала прочитать документ, модифицировать массив в коде вашего приложения,
// а затем передать весь измененный массив в updatesObject.
```

#### `async collection.remove(id)`

Удаляет документ с указанным `_id`.
*   `id` (string): `_id` документа.
*   Возвращает: `Promise<boolean>` - `true` если удален, `false` если не найден.

```javascript
const wasDeleted = await productsCollection.remove(newProduct._id);
console.log('Продукт удален:', wasDeleted);
```

#### `async collection.count([queryFunction])`

Подсчитывает количество документов.
*   `queryFunction` (function, необязательный): `(document) => boolean`. Если не предоставлена, подсчитываются все документы.
*   Возвращает: `Promise<number>` - количество документов.

```javascript
const totalProducts = await productsCollection.count();
console.log('Общее количество продуктов:', totalProducts);

const techCorpCount = await productsCollection.count(item => item.brand === 'TechCorp');
console.log('Количество продуктов TechCorp:', techCorpCount);
```

#### `async collection.upsert(query, dataToUpsert, [options])`

Обновляет документ, если найден по `query`, иначе вставляет новый.
*   `query` (object | function): Объект для поиска по точному совпадению или функция-предикат.
*   `dataToUpsert` (object): Данные для вставки/обновления.
*   `options` (object, необязательный):
    *   `setOnInsert` (object): Данные, применяемые только при вставке.
*   Возвращает: `Promise<{document: object, operation: 'inserted' | 'updated'}>`.

```javascript
// Предположим, у нас есть коллекция usersCollection
// const usersCollection = await db.collection('users');

const userProfile = { name: 'Иван Иванов', city: 'Москва' };
const userQuery = { email: 'ivan@example.com' }; // Поле, по которому ищем для обновления/вставки

const upsertResult = await usersCollection.upsert(
    userQuery,    // Если найден пользователь с таким email, он будет обновлен
    userProfile,  // Данные для обновления или основные данные для вставки
    { 
        setOnInsert: { 
            registrationDate: new Date().toISOString(), 
            bonusPoints: 0 
        } 
    } // Доп. поля при вставке
);
    
if (upsertResult.operation === 'inserted') {
    console.log('Новый пользователь создан:', upsertResult.document);
} else {
    console.log('Профиль пользователя обновлен:', upsertResult.document);
}
```

#### `async collection.getCollectionStats()`

Получает статистику по текущей коллекции.
*   Возвращает: `Promise<object>` - объект со статистикой, включающий:
    *   `documentCount` (number): Общее количество документов в коллекции.
    *   `segmentCount` (number): Количество файлов-сегментов, используемых коллекцией.
    *   `totalDiskSizeBytes` (number): Приблизительный общий размер коллекции на диске в байтах.
    *   `options` (object): Копия объекта опций, с которыми была сконфигурирована коллекция.

```javascript
async function displayCollectionStats() {
    try {
        const productsCollection = await db.collection('products');
        const stats = await productsCollection.getCollectionStats();
        console.log('Статистика коллекции "products":', stats);
        // Пример вывода:
        // Статистика коллекции "products": {
        //   documentCount: 150,
        //   segmentCount: 2,
        //   totalDiskSizeBytes: 180224,
        //   options: {
        //     maxSegmentSizeBytes: 262144,
        //     jsonIndent: 2,
        //     idGenerator: [Function: idGenerator] // или другое значение, если переопределено
        //   }
        // }
    } catch (error) {
        console.error('Ошибка при получении статистики коллекции:', error);
    }
}
// Вызов примера:
// displayCollectionStats().catch(console.error);
```

#### `async collection.clear()`

Удаляет все документы из коллекции.
*   Все существующие файлы сегментов коллекции будут перезаписаны пустыми массивами (`[]`).
*   Индекс текущего активного сегмента (`currentSegmentIndex`) будет сброшен на `0`.
*   Операция является атомарной на уровне коллекции благодаря внутренней очереди записи.
*   Возвращает: `Promise<void>`.

```javascript
async function clearUserCollection() {
    try {
        const usersCollection = await db.collection('users');
        
        // Перед очисткой, получим количество документов
        let countBefore = await usersCollection.count();
        console.log(`Коллекция "users" содержит ${countBefore} документов перед очисткой.`);

        await usersCollection.clear();
        console.log('Коллекция "users" была успешно очищена.');

        // Проверим количество документов после очистки
        let countAfter = await usersCollection.count();
        console.log(`Коллекция "users" содержит ${countAfter} документов после очистки.`); // Ожидается 0

    } catch (error) {
        console.error('Ошибка при очистке коллекции "users":', error);
    }
}
// Вызов примера:
// clearUserCollection().catch(console.error);
```

### 4. Хуки / События

WiseJSON позволяет реагировать на изменения данных через систему событий.

*   **`collection.on(eventName, listenerFunction)`**: Подписывает `listenerFunction` на событие `eventName`.
*   **`collection.off(eventName, [listenerFunction])`**: Отписывает `listenerFunction` от события. Если `listenerFunction` не указана, отписывает всех слушателей для `eventName`.

**Поддерживаемые события:**

*   `'afterInsert'(insertedDocument)`: Срабатывает после успешной вставки нового документа.
*   `'afterUpdate'(updatedDocument, oldDocumentSnapshot)`: Срабатывает после успешного обновления документа. `oldDocumentSnapshot` - это копия документа до применения изменений.
*   `'afterRemove'(removedDocumentId, removedDocumentSnapshot)`: Срабатывает после успешного удаления документа. `removedDocumentSnapshot` - это копия удаленного документа.
*   *Примечание: событие для `clear()` в данный момент не реализовано, но может быть добавлено в будущем.*

**Важно:**

*   Слушатели событий выполняются асинхронно и не блокируют завершение основной CRUD-операции.
*   Ошибки внутри слушателя логируются WiseJSON, но не влияют на результат основной операции.

```javascript
// Пример: создадим коллекцию для аудита, если она еще не существует
// const auditLogCollection = await db.collection('audit_log'); 

productsCollection.on('afterInsert', async (newProduct) => { 
    console.log(`EVENT: Продукт добавлен - ID: ${newProduct._id}, Имя: ${newProduct.name}`);
    try { 
        // await auditLogCollection.insert({ 
        //     action: 'PRODUCT_CREATED', 
        //     productId: newProduct._id, 
        //     details: `Продукт "${newProduct.name}" был создан.`,
        //     timestamp: new Date().toISOString() 
        // }); 
    } catch (auditError) { 
        console.error("Ошибка записи в аудит лог (afterInsert):", auditError); 
    }
});

productsCollection.on('afterUpdate', async (updatedDoc, oldDoc) => {
    console.log(`EVENT: Продукт обновлен - ID: ${updatedDoc._id}. Старая цена: ${oldDoc.price}, Новая цена: ${updatedDoc.price}`);
    // Логика аудита для обновления...
});

productsCollection.on('afterRemove', async (removedId, removedDoc) => {
    console.log(`EVENT: Продукт удален - ID: ${removedId}. Имя удаленного продукта: ${removedDoc.name}`);
    // Логика аудита для удаления...
});
```

## Модель параллелизма и обработка запросов

WiseJSON разработана с учетом надежности и предсказуемости в среде Node.js.

*   **Операции записи (модификации данных):**
    *   Все операции, изменяющие данные коллекции (`insert`, `update`, `remove`, `upsert`, `clear`), являются асинхронными и помещаются во внутреннюю очередь для каждой коллекции.
    *   Эти операции выполняются **строго последовательно** в рамках одной коллекции. Это означает, что если вы одновременно отправите несколько запросов на изменение данных в одну и ту же коллекцию, они будут выполнены один за другим, а не параллельно.
    *   Такой подход гарантирует консистентность данных на уровне файлов сегментов и предотвращает гонки состояний, которые могли бы привести к повреждению данных.
    *   Ваше приложение может инициировать множество асинхронных запросов на запись (например, через `Promise.all()`). WiseJSON корректно обработает их, поставив в очередь.

*   **Операции чтения:**
    *   Операции чтения (`getAll`, `find`, `findOne`, `getById`, `count`, `getCollectionStats`) также асинхронны, но **не используют очередь записи**.
    *   Несколько операций чтения могут выполняться параллельно друг с другом и с операциями записи, которые находятся в очереди или выполняются (насколько это позволяет событийный цикл Node.js и дисковая подсистема).
    *   Операции чтения видят состояние данных, которое было зафиксировано на диске на момент их выполнения. WiseJSON не предоставляет уровней изоляции транзакций (например, "snapshot isolation"). Благодаря атомарной процедуре обновления файлов сегментов (с использованием `.new` и `.bak` файлов), чтение обычно получает либо полностью старую, либо полностью новую версию сегмента, избегая чтения частично измененных или поврежденных данных.

*   **Инициализация коллекций:**
    *   При первом обращении к коллекции через `db.collection('collectionName')` происходит ее асинхронная инициализация (создание директории, проверка и восстановление сегментов).
    *   WiseJSON гарантирует, что даже при множественных одновременных запросах на одну и ту же новую коллекцию, фактический процесс инициализации (включая дисковые операции) будет выполнен только один раз. Последующие запросы будут ожидать завершения этой первой инициализации.

Эта модель обеспечивает баланс между надежностью, простотой использования и достаточной производительностью для целевых сценариев использования WiseJSON.

## Структура хранения данных

*   **Корневая директория:** Указывается при создании `new WiseJSON(dbRootPath)`.
*   **Директории коллекций:** Создаются внутри корневой директории (например, `dbRootPath/products/`).
*   **Файлы-сегменты:** Внутри директории коллекции (например, `products_0.json`, `products_1.json`).
    *   Новый сегмент (`collectionName_N+1.json`) создается, когда текущий сегмент (`collectionName_N.json`), будучи непустым, при добавлении новой записи превысил бы лимит `maxSegmentSizeBytes`. Количество файлов-сегментов зависит от общего объема данных и настройки `maxSegmentSizeBytes`.
*   **Формат документа:** Каждый документ в JSON-файле является объектом и автоматически получает поля:
    *   `_id` (string): Уникальный идентификатор (по умолчанию UUID v4, можно настроить через опцию `idGenerator` в конструкторе `WiseJSON` или `db.collection()`).
    *   `createdAt` (string): Время создания документа в формате ISO 8601.
    *   `updatedAt` (string): Время последнего обновления документа в формате ISO 8601.

## Обработка ошибок

Все асинхронные методы WiseJSON возвращают промисы. При возникновении ошибок (проблемы с файловой системой, невалидный JSON, некорректные аргументы методов и т.д.) промис будет отклонен (`rejected`) с объектом `Error`, содержащим описание проблемы (обычно с префиксом `WiseJSON: ...` или `WiseJSON Collection ('collectionName'): ...`). Используйте `try...catch` с `async/await` или метод `.catch()` для обработки этих ошибок в вашем приложении.

```javascript
try {
    const product = await productsCollection.getById('несуществующий-id');
    if (!product) {
        console.log('Продукт не найден.');
    }
} catch (error) {
    console.error(`Ошибка при доступе к данным: ${error.message}`);
    // Например, если файл сегмента поврежден, error.message будет содержать эту информацию.
}
```

## Тестирование

WiseJSON включает набор тестов (например, `advanced-test-wise-json.js` и `durability-test-wise-json.js`), которые проверяют основной функционал и надежность.
Для запуска:
1.  Убедитесь, что вы находитесь в корневой директории проекта, где расположены файлы тестов и папка `wise-json`.
2.  Выполните в терминале:
    ```bash
    node path/to/your/test-file.js
    ```
    (например, `node test/advanced-test-wise-json.js`, если тесты в папке `test`).

Тестовые скрипты создадут временную директорию (например, `test_db_data_advanced`) для своих нужд.

## Ограничения и Рекомендации

*   **Транзакции между коллекциями:** WiseJSON **не обеспечивает** атомарные транзакции, охватывающие несколько коллекций. Логика консистентности для таких операций реализуется на уровне приложения.
*   **Ссылочная целостность:** Не поддерживается.
*   **Одновременный доступ из нескольких процессов:** WiseJSON **не предназначена** для одновременной модификации одной базы данных (`dbRootPath`) из нескольких независимых процессов Node.js. Использование из одного процесса Node.js с множеством асинхронных операций безопасно благодаря внутренней очереди записи и механизмам инициализации (см. раздел "Модель параллелизма"). Для многопроцессного доступа к общим данным требуются специализированные СУБД или механизмы межпроцессной синхронизации, выходящие за рамки WiseJSON.
*   **Производительность:** Оптимизирована для простоты и надежности. На очень больших данных операции полного сканирования (`find`, `count` без использования специализированных индексов) могут замедляться. В текущей версии индексы, кроме внутреннего неявного поиска по `_id`, отсутствуют.
*   **Резервное копирование:** Регулярно создавайте резервные копии всей директории `dbRootPath`. Это стандартная практика для любых систем хранения данных.
*   **Индексы:** Отсутствуют (кроме внутреннего неявного поиска по `_id`). Поиск по полям, отличным от `_id` (через `find`/`findOne`), требует полного сканирования сегментов коллекции.

## Лицензия

MIT License

Copyright (c) 2025 Guliaev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.