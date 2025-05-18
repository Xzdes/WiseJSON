# WiseJSON

WiseJSON - это легковесная встраиваемая база данных на основе JSON-файлов, созданная на чистом JavaScript для среды Node.js. Она ориентирована на проекты, где требуется простое, но надежное локальное хранилище данных без необходимости установки, настройки и администрирования внешних СУБД. Ключевыми принципами WiseJSON являются надежность операций, предсказуемость поведения и простота использования API.

## Основные возможности

*   **Хранение данных в JSON-файлах:** Данные организованы в именованные коллекции. Каждая коллекция физически представляет собой директорию, содержащую один или несколько файлов-сегментов в формате JSON.
*   **Автоматическая сегментация файлов:** Для эффективной работы с большими объемами данных, WiseJSON автоматически разделяет данные коллекции на более мелкие файлы-сегменты. Новый сегмент создается, когда размер текущего сегмента достигает предварительно настроенного лимита.
*   **Надежные операции записи:** Операции изменения данных (`insert`, `update`, `remove`, `upsert`) используют стратегию записи во временный файл с последующим атомарным переименованием. Это снижает риск повреждения данных при сбоях.
*   **Последовательное выполнение операций записи:** В рамках коллекции операции изменения данных выполняются последовательно, что предотвращает гонки состояний и обеспечивает консистентность данных.
*   **Гибкий асинхронный API:** Предоставляет асинхронные методы (возвращающие промисы) для CRUD-операций, подсчета документов и условной вставки/обновления (`upsert`).
*   **Минимальные зависимости:** WiseJSON написана на чистом JavaScript и использует только встроенные модули Node.js (`fs/promises`, `path`) и `uuid` для генерации идентификаторов документов.
*   **Настраиваемость:** Позволяет конфигурировать путь к хранилищу данных, максимальный размер файла-сегмента, форматирование JSON и функцию для генерации ID документов.
*   **Система хуков (событий):** Механизм для подписки на события жизненного цикла документов (`afterInsert`, `afterUpdate`, `afterRemove`), позволяющий расширять функциональность приложения.

## Установка

1.  **Скопируйте библиотеку:**
    Поместите директорию `wise-json` (которая содержит файлы `index.js` и `collection.js`) в структуру вашего проекта. Например, в папку `lib/wise-json/` или непосредственно в корень проекта.

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
const WiseJSON = require('./path/to/wise-json');
const path = require('path');

// Определите путь к КОРНЕВОЙ ДИРЕКТОРИИ, где WiseJSON будет хранить все свои данные.
// WiseJSON автоматически создаст эту директорию, если она не существует.
// Рекомендуется использовать абсолютный путь или путь, вычисляемый относительно
// вашего приложения (например, с помощью path.resolve(__dirname, 'folder_name')).
const dbStoragePath = path.resolve(__dirname, 'application_database'); // Пример

// Глобальные опции (необязательно):
const globalOptions = {
    maxSegmentSizeBytes: 512 * 1024, // Максимальный размер сегмента 512KB (по умолчанию 1MB).
    jsonIndent: 2,                   // Форматировать JSON с отступом в 2 пробела (по умолчанию 2).
                                     // Установите null или 0 для компактного JSON без отступов.
    // idGenerator: () => `my-prefix-${Date.now()}-${Math.random().toString(36).substring(2)}` // Пример кастомного генератора ID
};

const db = new WiseJSON(dbStoragePath, globalOptions);

// Инициализация базовой директории асинхронна.
// Рекомендуется дождаться ее завершения перед активными операциями,
// особенно если ваше приложение стартует и сразу начинает работу с БД.
db.baseDirInitPromise
    .then(() => {
        console.log('WiseJSON: Хранилище данных готово к использованию.');
        // Здесь можно запускать основную логику вашего приложения,
        // например, инициализировать Express-сервер или начать обработку данных.
        startApplication();
    })
    .catch(initializationError => {
        console.error('WiseJSON: КРИТИЧЕСКАЯ ОШИБКА при инициализации хранилища. Приложение не может стартовать.', initializationError);
        process.exit(1); // Завершение работы, если БД не может быть инициализирована
    });
    
async function startApplication() {
    // ... ваша логика ...
    // Например, работа с коллекциями:
    // manageProducts().catch(console.error);
}
```

2. Работа с Коллекциями
Данные в WiseJSON организуются в коллекции. Каждая коллекция управляется отдельным экземпляром класса Collection.
async function manageProducts() {
    try {
        // Получение (или создание при первом обращении) коллекции 'products'.
        // Опции, переданные здесь, переопределят глобальные опции для этой конкретной коллекции.
        const productsCollection = await db.collection('products', {
            maxSegmentSizeBytes: 256 * 1024 // Сегменты для товаров будут не более 256KB
        });

        // Теперь можно работать с productsCollection...
        // Например:
        // const allProds = await productsCollection.getAll();
        // console.log('Все продукты:', allProds);
        
    } catch (error) {
        console.error('Ошибка при получении коллекции "products":', error);
    }
}

3. API Коллекции (Collection)
Все методы экземпляра Collection асинхронны и возвращают Promise.
async collection.insert(dataObject)
Вставляет новый документ в коллекцию.
```javascript
dataObject (object): Объект с данными для нового документа.
Поля _id, createdAt и updatedAt будут автоматически сгенерированы или перезаписаны библиотекой. Если вы хотите использовать собственный генератор _id, настройте его через опцию idGenerator.
Возвращает: Promise<object> - вставленный документ, включающий _id, createdAt, updatedAt.
const newProduct = await productsCollection.insert({
    name: 'Умные часы Series X',
    brand: 'TechCorp',
    price: 12990,
    features: ['GPS', 'Heart rate monitor'],
    stock: 75
});
```
```javascript
async collection.getById(id)

Находит документ по его уникальному идентификатору _id.
id (string): _id искомого документа.
Возвращает: Promise<object|null> - найденный документ или null, если документ не найден.
const product = await productsCollection.getById(newProduct._id);
Use code with caution.
```
```JavaScript
async collection.find(queryFunction)

Находит все документы, удовлетворяющие условию, заданному функцией-предикатом.
Возвращает: Promise<object[]> - массив найденных документов. Может быть пустым.
const techCorpProducts = await productsCollection.find(
    item => item.brand === 'TechCorp' && item.price < 15000
);
Use code with caution.
```
```JavaScript
async collection.findOne(queryFunction)

Находит первый документ, удовлетворяющий условию, заданному функцией-предикатом.
Возвращает: Promise<object|null> - первый найденный документ или null.
const firstInStock = await productsCollection.findOne(item => item.stock > 0);
Use code with caution.
```
```JavaScript
async collection.getAll()
Получает все документы из коллекции.
Возвращает: Promise<object[]> - массив всех документов коллекции.
const allItems = await productsCollection.getAll();
Use code with caution.
```
```JavaScript
async collection.update(id, updatesObject)

Обновляет документ с указанным _id.
id (string): _id документа для обновления.
updatesObject (object): Объект, содержащий поля и их новые значения.
Поле _id в updatesObject будет проигнорировано (изменение _id не поддерживается).
Поле createdAt не изменяется.
Поле updatedAt будет автоматически обновлено.
Возвращает: Promise<object|null> - обновленный документ или null, если документ с таким id не найден.
const updated = await productsCollection.update(newProduct._id, {
    price: 12500,
    stock: 70
});
// Для сложных обновлений массивов (например, добавление/удаление элементов) рекомендуется
// сначала прочитать документ, модифицировать массив в коде вашего приложения,
// а затем передать весь измененный массив в updatesObject.
// WiseJSON применит объект updates поверх существующего документа.
Use code with caution.
JavaScript
async collection.remove(id)

Удаляет документ с указанным _id.
id (string): _id документа для удаления.
Возвращает: Promise<boolean> - true, если документ был успешно удален, false - если документ не найден.
const wasDeleted = await productsCollection.remove(newProduct._id);
Use code with caution.
JavaScript
async collection.count([queryFunction])

Подсчитывает количество документов в коллекции.
queryFunction (function, необязательный): Функция-фильтр (document) => boolean. Если не предоставлена, подсчитываются все документы.
Возвращает: Promise<number> - количество документов.
const totalProducts = await productsCollection.count();
const techCorpCount = await productsCollection.count(item => item.brand === 'TechCorp');
Use code with caution.
JavaScript
async collection.upsert(query, dataToUpsert, [options])

Обновляет документ, если он найден по query, иначе вставляет новый.
query (object | function):
Объект: Поиск по точному совпадению всех полей объекта.
Функция: Предикат (document) => boolean для поиска.
dataToUpsert (object): Данные для вставки или обновления. При обновлении, поля из dataToUpsert сольются с существующим документом. При вставке, если query был объектом, его поля также могут войти в новый документ (поля из dataToUpsert имеют приоритет).
options (object, необязательный):
setOnInsert (object): Объект данных, которые будут применены (добавлены/перезаписаны) только если происходит вставка нового документа.
Возвращает: Promise<{document: object, operation: 'inserted' | 'updated'}> - объект с результирующим документом и типом выполненной операции.
// Пример: обновить профиль пользователя по email или создать новый
const userProfile = { name: 'Иван Иванов', city: 'Москва' };
const userQuery = { email: 'ivan@example.com' }; // Поле, по которому ищем для обновления/вставки
const upsertResult = await usersCollection.upsert(
    userQuery,    // Если найден пользователь с таким email, он будет обновлен
    userProfile,  // Данные для обновления или основные данные для вставки
    { setOnInsert: { registrationDate: new Date().toISOString(), bonusPoints: 0 } } // Доп. поля при вставке
);
    
if (upsertResult.operation === 'inserted') {
    console.log('Новый пользователь создан:', upsertResult.document);
} else {
    console.log('Профиль пользователя обновлен:', upsertResult.document);
}
Use code with caution.
JavaScript
```
4. Хуки / События

WiseJSON позволяет подписываться на события жизненного цикла документов в коллекции. Это может быть полезно для логирования, аудита, инвалидации кэша или запуска связанных процессов (но без гарантий транзакционности).
collection.on(eventName, listenerFunction): Подписывает listenerFunction на событие eventName.
collection.off(eventName, [listenerFunction]): Отписывает listenerFunction от события. Если listenerFunction не указана, отписывает всех слушателей для eventName.
Поддерживаемые события:
'afterInsert'(insertedDocument): Срабатывает после успешной вставки нового документа.
'afterUpdate'(updatedDocument, oldDocumentSnapshot): Срабатывает после успешного обновления документа. oldDocumentSnapshot - это копия документа до применения изменений.
'afterRemove'(removedDocumentId, removedDocumentSnapshot): Срабатывает после успешного удаления документа. removedDocumentSnapshot - это копия удаленного документа.

**Важно:**

*   Слушатели событий выполняются асинхронно и не блокируют завершение основной CRUD-операции.
*   Ошибки внутри слушателя логируются WiseJSON, но не влияют на результат основной операции.

```javascript
const auditLogCollection = await db.collection('audit_log'); // Пример коллекции для аудита.

productsCollection.on('afterInsert', async (newProduct) => { // Пример хука на добавление продукта.
    console.log(`EVENT: Продукт добавлен - ID: ${newProduct._id}, Имя: ${newProduct.name}`);
    try { await auditLogCollection.insert({ action: 'PRODUCT_CREATED', productId: newProduct._id, details: { name: newProduct.name, price: newProduct.price }, timestamp: new Date().toISOString() }); }
    catch (auditError) { console.error("Ошибка записи в аудит лог (afterInsert):", auditError); }
});

productsCollection.on('afterUpdate', async (updatedProduct, oldProduct) => { // Пример хука на обновление продукта.
    console.log(`EVENT: Продукт обновлен - ID: ${updatedProduct._id}, Старое имя: ${oldProduct.name}, Новое имя: ${updatedProduct.name}`);
    // Здесь можно добавить логирование изменений...
});
```

## Структура хранения данных

Корневая директория: Указывается при создании new WiseJSON(dbRootPath).
Директории коллекций: Создаются внутри корневой директории (например, dbRootPath/products/).
Файлы-сегменты: Внутри директории коллекции (например, products_0.json, products_1.json).
Новый сегмент (collectionName_N+1.json) создается, когда текущий сегмент (collectionName_N.json), будучи непустым, при добавлении новой записи превысил бы лимит maxSegmentSizeBytes. Количество файлов-сегментов зависит от объема данных в коллекции и значения maxSegmentSizeBytes.
Формат документа: Каждый документ в JSON-файле является объектом и автоматически получает следующие поля:
_id (string): Уникальный идентификатор (по умолчанию UUID v4, можно настроить через опцию idGenerator в конструкторе WiseJSON или db.collection()).
createdAt (string): Время создания документа в формате ISO 8601.
updatedAt (string): Время последнего обновления документа в формате ISO 8601.

## Обработка ошибок

Все асинхронные методы WiseJSON возвращают промисы. При возникновении ошибок (проблемы с файловой системой, невалидный JSON, некорректные аргументы методов и т.д.) промис будет отклонен (rejected) с объектом Error, содержащим описание проблемы. Используйте try...catch с async/await или метод .catch() для обработки этих ошибок в вашем приложении.
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

WiseJSON включает набор тестов (advanced-test-wise-json.js), которые проверяют основной функционал.
Для запуска:
Убедитесь, что вы находитесь в корневой директории вашего проекта, где расположен файл advanced-test-wise-json.js и папка wise-json.
Выполните команду в терминале:
node advanced-test-wise-json.js
Тестовый скрипт создаст временную директорию test_db_data_advanced для своих нужд. Вы можете раскомментировать строку await cleanupTestDB(); в конце файла advanced-test-wise-json.js для автоматической очистки после тестов.

## Ограничения и рекомендации

Транзакции между коллекциями: WiseJSON не обеспечивает атомарные транзакции, охватывающие несколько коллекций или операций. Обеспечение консистентности в таких сценариях (например, с помощью компенсирующих транзакций) является ответственностью приложения.
Ссылочная целостность: Не поддерживается.
Одновременный доступ из нескольких процессов: WiseJSON не предназначена для одновременной модификации одной и той же базы данных (dbRootPath) из нескольких независимых процессов Node.js. Это может привести к повреждению данных.
Производительность: Оптимизирована для простоты и надежности. Для очень высоких нагрузок или больших данных, операции чтения, требующие полного сканирования коллекции (например, find или count без очень специфичных оптимизаций), могут замедляться с ростом числа сегментов.
Резервное копирование: Регулярно создавайте резервные копии всей директории dbRootPath.
Индексы: Отсутствуют сложные механизмы индексирования. Поиск по полям, отличным от `_id` (через `find`/`findOne` с функцией-предикатом), требует полного сканирования данных коллекции.

## Лицензия

MIT License

Copyright (c) 2025 Guliaev

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
