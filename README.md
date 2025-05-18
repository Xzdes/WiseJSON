# WiseJSON

WiseJSON - это легковесная, встраиваемая база данных на основе JSON-файлов, созданная на чистом JavaScript для среды Node.js. Она ориентирована на проекты, где требуется простое, но надежное локальное хранилище данных без необходимости установки, настройки и администрирования внешних систем управления базами данных. Ключевыми принципами WiseJSON являются надежность операций, предсказуемость поведения и простота использования API.

**Основные возможности:**

*   **Хранение данных в JSON-файлах:** Данные организованы в именованные коллекции. Каждая коллекция физически представляет собой директорию, содержащую один или несколько файлов-сегментов в формате JSON.
*   **Автоматическая сегментация файлов:** Для эффективной работы с растущими объемами данных, WiseJSON автоматически разделяет данные коллекции на более мелкие файлы-сегменты. Новый сегмент создается, когда размер текущего сегмента достигает предварительно настроенного лимита, предотвращая появление чрезмерно больших и медленных для обработки JSON-файлов.
*   **Надежные операции записи:** Все операции, изменяющие данные (`insert`, `update`, `remove`, `upsert`), используют стратегию записи во временный файл с последующим атомарным (на большинстве файловых систем) переименованием. Это значительно снижает риск повреждения данных при неожиданных сбоях приложения или системы.
*   **Последовательное выполнение операций записи:** В рамках одной коллекции все операции, изменяющие данные, выполняются строго последовательно благодаря внутренней очереди. Это предотвращает гонки состояний и обеспечивает консистентность данных на уровне коллекции.
*   **Гибкий асинхронный API:** Предоставляет интуитивно понятный набор асинхронных методов (возвращающих промисы) для всех стандартных CRUD-операций, а также для подсчета документов и условной вставки/обновления (`upsert`).
*   **Минимальные зависимости:** WiseJSON написана на чистом JavaScript и использует только встроенные модули Node.js (`fs/promises`, `path`) и одну легковесную внешнюю зависимость (`uuid`) для генерации уникальных идентификаторов документов.
*   **Настраиваемость:** Позволяет пользователю конфигурировать ключевые параметры, такие как путь к хранилищу данных, максимальный размер файла-сегмента, форматирование JSON-файлов и даже функцию для генерации ID документов.
*   **Система хуков (событий):** Предоставляет простой механизм для подписки на события жизненного цикла документов (`afterInsert`, `afterUpdate`, `afterRemove`), позволяя расширять функциональность приложения без модификации ядра библиотеки.

## Установка

1.  **Скопируйте библиотеку:** Поместите директорию `wise-json` (которая содержит файлы `index.js` и `collection.js`) в ваш проект. Например, в папку `lib/wise-json/` или непосредственно в корень проекта.

2.  **Установите зависимость `uuid`:** Если она еще не установлена в вашем проекте, выполните:
    ```bash
    npm install uuid
    # или если вы используете yarn:
    yarn add uuid
    ```

## Использование

### 1. Инициализация WiseJSON

Сначала необходимо создать экземпляр класса `WiseJSON`, указав путь к директории, где будут храниться все данные.

```javascript
const WiseJSON = require('./path/to/wise-json'); // Укажите правильный путь к wise-json/index.js
const path = require('path');

// Определите путь для хранения базы данных.
// Рекомендуется использовать абсолютный путь или путь, разрешаемый из корня вашего приложения.
const dbStoragePath = path.resolve(__dirname, 'application_database');

// Глобальные опции для всех коллекций (необязательно):
const globalOptions = {
    maxSegmentSizeBytes: 512 * 1024, // Максимальный размер сегмента 512KB (по умолчанию 1MB)
    jsonIndent: 2,                   // Форматировать JSON с отступом в 2 пробела (по умолчанию 2)
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
}
Use code with caution.
Md
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
    } catch (error) {
        console.error('Ошибка при получении коллекции "products":', error);
    }
}
Use code with caution.
JavaScript
3. API Коллекции (Collection)
Все методы экземпляра Collection асинхронны и возвращают Promise.
async collection.insert(dataObject)
Вставляет новый документ в коллекцию.
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
// newProduct: { _id: '...', name: '...', ..., createdAt: '...', updatedAt: '...' }
Use code with caution.
JavaScript
async collection.getById(id)
Находит документ по его уникальному идентификатору _id.
id (string): _id искомого документа.
Возвращает: Promise<object|null> - найденный документ или null, если документ не найден.
const product = await productsCollection.getById(newProduct._id);
Use code with caution.
JavaScript
async collection.find(queryFunction)
Находит все документы, удовлетворяющие условию, заданному функцией-предикатом.
queryFunction (function): Функция вида (document) => boolean. Возвращает true, если документ соответствует критерию.
Возвращает: Promise<object[]> - массив найденных документов. Может быть пустым.
const techCorpProducts = await productsCollection.find(
    item => item.brand === 'TechCorp' && item.price < 15000
);
Use code with caution.
JavaScript
async collection.findOne(queryFunction)
Находит первый документ, удовлетворяющий условию, заданному функцией-предикатом.
queryFunction (function): Функция вида (document) => boolean.
Возвращает: Promise<object|null> - первый найденный документ или null.
const firstInStock = await productsCollection.findOne(item => item.stock > 0);
Use code with caution.
JavaScript
async collection.getAll()
Получает все документы из коллекции.
Возвращает: Promise<object[]> - массив всех документов коллекции.
const allItems = await productsCollection.getAll();
Use code with caution.
JavaScript
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
    stock: 70,
    'features[]': 'Sleep tracking' // Пример обновления элемента массива (потребует кастомной логики в приложении или полного переопределения массива)
                                  // WiseJSON просто сольет объекты. Для массивов это может означать замену.
});
// Для сложных обновлений массивов (добавление/удаление элементов) лучше сначала прочитать документ,
// модифицировать массив в коде, а затем передать весь измененный массив в updatesObject.
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
const userQuery = { email: 'ivan@example.com' };
const upsertResult = await usersCollection.upsert(
    userQuery,
    userProfile,
    { setOnInsert: { registrationDate: new Date().toISOString(), bonusPoints: 0 } }
);

if (upsertResult.operation === 'inserted') {
    console.log('Новый пользователь создан:', upsertResult.document);
} else {
    console.log('Профиль пользователя обновлен:', upsertResult.document);
}
Use code with caution.
JavaScript
4. Хуки / События
WiseJSON позволяет подписываться на события жизненного цикла документов в коллекции. Это может быть полезно для логирования, аудита, инвалидации кэша или запуска связанных процессов (но без гарантий транзакционности).
collection.on(eventName, listenerFunction): Подписывает listenerFunction на событие eventName.
collection.off(eventName, [listenerFunction]): Отписывает listenerFunction от события. Если listenerFunction не указана, отписывает всех слушателей для eventName.
Поддерживаемые события:
'afterInsert'(insertedDocument): Срабатывает после успешной вставки нового документа.
'afterUpdate'(updatedDocument, oldDocumentSnapshot): Срабатывает после успешного обновления документа. oldDocumentSnapshot - это копия документа до применения изменений.
'afterRemove'(removedDocumentId, removedDocumentSnapshot): Срабатывает после успешного удаления документа. removedDocumentSnapshot - это копия удаленного документа.
Важно:
Слушатели событий выполняются асинхронно и не блокируют завершение основной CRUD-операции.
Ошибки, возникшие внутри слушателя события, логируются WiseJSON, но не влияют на результат основной операции и не прерывают ее.
const auditLogCollection = await db.collection('audit_log');

productsCollection.on('afterInsert', async (newProduct) => {
    console.log(`EVENT: Продукт добавлен - ID: ${newProduct._id}, Имя: ${newProduct.name}`);
    await auditLogCollection.insert({
        action: 'PRODUCT_CREATED',
        productId: newProduct._id,
        details: { name: newProduct.name, price: newProduct.price },
        timestamp: new Date().toISOString()
    });
});

productsCollection.on('afterUpdate', async (updatedProduct, oldProduct) => {
    console.log(`EVENT: Продукт обновлен - ID: ${updatedProduct._id}, Старое имя: ${oldProduct.name}, Новое имя: ${updatedProduct.name}`);
    // Логирование изменений...
});
Use code with caution.
JavaScript
Структура Хранения Данных
Корневая директория: Указывается при создании new WiseJSON(dbRootPath).
Директории коллекций: Создаются внутри корневой директории (например, dbRootPath/products/).
Файлы-сегменты: Внутри директории коллекции (например, products_0.json, products_1.json). Новый сегмент создается, когда текущий (непустой) сегмент при добавлении новой записи превысил бы maxSegmentSizeBytes.
Формат документа: Каждый документ в JSON-файле является объектом и автоматически получает следующие поля:
_id (string): Уникальный идентификатор (по умолчанию UUID v4, можно настроить через idGenerator).
createdAt (string): Время создания документа в формате ISO 8601.
updatedAt (string): Время последнего обновления документа в формате ISO 8601.
Обработка Ошибок
Все асинхронные методы WiseJSON возвращают промисы. При возникновении ошибок (проблемы с файловой системой, невалидный JSON, некорректные аргументы методов и т.д.) промис будет отклонен (rejected) с объектом Error, содержащим описание проблемы. Используйте try...catch с async/await или метод .catch() для обработки этих ошибок в вашем приложении.
try {
    const product = await productsCollection.getById('несуществующий-id');
    if (!product) {
        // ...
    }
} catch (error) {
    console.error(`Ошибка при доступе к данным: ${error.message}`);
    // Например, если файл сегмента поврежден, error.message будет содержать эту информацию.
}
Use code with caution.
JavaScript
Тестирование
WiseJSON включает набор тестов (advanced-test-wise-json.js), которые проверяют основной функционал.
Для запуска:
Убедитесь, что вы находитесь в корневой директории проекта.
Выполните: node advanced-test-wise-json.js
Тесты создадут временную директорию test_db_data_advanced.
Ограничения и Рекомендации
Транзакции между коллекциями: WiseJSON не поддерживает атомарные транзакции, охватывающие несколько коллекций или операций. Обеспечение консистентности в таких сценариях (например, с помощью компенсирующих транзакций) является ответственностью приложения.
Ссылочная целостность: Не поддерживается.
Одновременный доступ из нескольких процессов: WiseJSON не предназначена для одновременной модификации одной и той же базы данных (dbRootPath) из нескольких независимых процессов Node.js. Это может привести к повреждению данных.
Производительность: Оптимизирована для простоты и надежности. Для очень высоких нагрузок или больших данных, операции чтения, требующие полного сканирования коллекции, могут замедляться.
Резервное копирование: Регулярно создавайте резервные копии всей директории dbRootPath.
Индексы: В текущей версии отсутствуют сложные механизмы индексирования. Поиск по полям, отличным от _id (через find/findOne с функцией-предикатом), требует полного сканирования данных коллекции.
Лицензия
MIT License
Copyright (c) [2025] [Guliaev]
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