# WiseJSON

WiseJSON - это легковесная, встраиваемая база данных на основе JSON-файлов, написанная на чистом JavaScript для Node.js. Она предназначена для проектов, где требуется простое и надежное хранилище данных без необходимости установки и настройки внешних СУБД, и где приоритетом является надежность операций и простота использования.

**Основные возможности:**

*   **Хранение данных в JSON:** Данные организуются в коллекции, каждая из которых хранится в виде набора JSON-файлов (сегментов).
*   **Сегментация файлов:** Для предотвращения создания чрезмерно больших JSON-файлов, данные коллекции автоматически разделяются на сегменты по достижении настраиваемого лимита размера. Это помогает поддерживать производительность при работе с растущими объемами данных.
*   **Надежная запись:** Операции записи (`insert`, `update`, `remove`) используют механизм временных файлов и переименования для минимизации риска повреждения данных при сбоях приложения или системы.
*   **Последовательные операции записи:** В рамках одной коллекции операции, изменяющие данные, выполняются строго последовательно через внутреннюю очередь, предотвращая гонки состояний.
*   **Простой асинхронный API:** Интуитивно понятные методы, возвращающие промисы, для всех операций с данными.
*   **Минимум зависимостей:** Использует только встроенные модули Node.js и `uuid` для генерации уникальных идентификаторов документов.
*   **Конфигурируемость:** Позволяет настраивать путь к хранилищу данных, максимальный размер сегмента файла и форматирование JSON.

## Установка

1.  Скопируйте директорию `wise-json` (содержащую файлы `index.js` и `collection.js`) в структуру вашего проекта.
2.  Убедитесь, что в вашем проекте установлена зависимость `uuid`. Если нет, установите ее:
    ```bash
    npm install uuid
    # или
    yarn add uuid
    ```

## Быстрый старт

```javascript
const WiseJSON = require('./path/to/wise-json'); // Укажите корректный путь к wise-json/index.js
const path = require('path');

// Определите путь, где будет храниться ваша база данных
const dbPath = path.resolve(__dirname, 'my_application_data');

// Инициализация WiseJSON. Глобальные опции можно задать здесь.
const db = new WiseJSON(dbPath, {
    // maxSegmentSizeBytes: 1024 * 1024, // 1MB (по умолчанию)
    // jsonIndent: 2, // 2 пробела для форматирования (по умолчанию), null для компактного JSON
});

async function appLogic() {
    try {
        // Получение (или создание, если не существует) коллекции 'products'
        // Можно указать опции, специфичные для этой коллекции
        const productsCollection = await db.collection('products', {
            maxSegmentSizeBytes: 512 * 1024 // 512KB для сегментов товаров
        });

        // Вставка нового документа
        const newProduct = await productsCollection.insert({
            name: 'Беспроводные наушники Alpha',
            price: 4990,
            category: 'Аудио',
            stock: 50
        });
        console.log('Добавлен продукт:', newProduct);

        // Поиск продукта по ID
        const foundProduct = await productsCollection.getById(newProduct._id);
        if (foundProduct) {
            console.log('Найден продукт по ID:', foundProduct);
        }

        // Обновление документа
        const updatedProduct = await productsCollection.update(newProduct._id, {
            price: 4790,
            stock: 45
        });
        console.log('Обновленный продукт:', updatedProduct);

        // Получение всех продуктов
        const allProducts = await productsCollection.getAll();
        console.log(`Всего продуктов: ${allProducts.length}`);

        // Удаление документа
        // const wasRemoved = await productsCollection.remove(newProduct._id);
        // if (wasRemoved) console.log('Продукт удален.');

    } catch (error) {
        console.error('Произошла ошибка при работе с WiseJSON:', error);
    }
}

// Важно дождаться инициализации базовой директории перед активной работой
db.baseDirInitPromise
    .then(() => {
        console.log('WiseJSON: База данных инициализирована и готова к работе.');
        appLogic();
        // Здесь можно запускать ваше основное приложение, сервер и т.д.
    })
    .catch(err => {
        console.error('WiseJSON: КРИТИЧЕСКАЯ ОШИБКА инициализации БД. Приложение не может стартовать.', err);
        process.exit(1); // Завершаем работу, если БД не может быть инициализирована
    });
Use code with caution.
Md
API
new WiseJSON(dbRootPath, [globalOptions])
dbRootPath (string, обязательный): Абсолютный или относительный путь к корневой директории, где будут храниться все данные WiseJSON. Библиотека попытается создать эту директорию, если она не существует.
globalOptions (object, необязательный): Глобальные опции, применяемые ко всем коллекциям по умолчанию.
maxSegmentSizeBytes (number): Максимальный размер одного файла-сегмента в байтах. По умолчанию: 1048576 (1MB).
jsonIndent (number | null): Количество пробелов для отступа при форматировании JSON-файлов. null или 0 для компактного JSON без отступов. По умолчанию: 2.
db.collection(collectionName, [collectionOptions])
Асинхронный метод для получения экземпляра коллекции.
collectionName (string, обязательный): Имя коллекции. Будет использовано для создания поддиректории.
collectionOptions (object, необязательный): Опции, специфичные для данной коллекции. Переопределяют globalOptions. Имеют ту же структуру, что и globalOptions.
Возвращает: Promise<Collection> - промис, который разрешается экземпляром Collection.
Экземпляр Collection
Все методы экземпляра Collection асинхронны и возвращают Promise.
collection.insert(dataObject)
Вставляет новый документ.
dataObject (object): Данные для нового документа. Поля _id, createdAt, updatedAt будут автоматически сгенерированы/перезаписаны.
Возвращает: Promise<object> - вставленный документ.
collection.getById(id)
Находит документ по _id.
id (string): Уникальный идентификатор.
Возвращает: Promise<object|null> - найденный документ или null.
collection.find(queryFunction)
Находит все документы, удовлетворяющие queryFunction.
queryFunction (function): (document) => boolean.
Возвращает: Promise<object[]> - массив найденных документов.
collection.findOne(queryFunction)
Находит первый документ, удовлетворяющий queryFunction.
queryFunction (function): (document) => boolean.
Возвращает: Promise<object|null> - найденный документ или null.
collection.getAll()
Получает все документы из коллекции.
Возвращает: Promise<object[]> - массив всех документов.
collection.update(id, updatesObject)
Обновляет документ с указанным _id.
id (string): _id документа.
updatesObject (object): Поля для обновления. _id и createdAt не изменяются. updatedAt обновляется автоматически.
Возвращает: Promise<object|null> - обновленный документ или null, если не найден.
collection.remove(id)
Удаляет документ с указанным _id.
id (string): _id документа.
Возвращает: Promise<boolean> - true если удален, false если не найден.
Структура Хранения Данных
Корневая директория: Задается при создании new WiseJSON(dbRootPath).
Директории коллекций: Внутри корневой директории, например, dbRootPath/products/, dbRootPath/users/.
Файлы-сегменты: Внутри директории коллекции, например, products_0.json, products_1.json.
Новый сегмент создается, когда текущий (непустой) сегмент при добавлении новой записи превысил бы maxSegmentSizeBytes.
Каждый сегмент – это JSON-массив документов.
Структура документа: Каждый документ автоматически получает поля:
_id (string): Уникальный идентификатор (UUID v4).
createdAt (string): Время создания в формате ISO 8601.
updatedAt (string): Время последнего обновления в формате ISO 8601.
Обработка Ошибок
Все асинхронные методы WiseJSON и Collection возвращают промисы. При возникновении ошибок (например, проблемы с файловой системой, поврежденные JSON-файлы, некорректные аргументы) промис будет отклонен (rejected) с объектом Error. Важно обрабатывать эти ошибки в вашем коде с помощью try...catch для async/await или метода .catch() для промисов.
Пример:
try {
    const data = await someCollection.getAll();
    // ...
} catch (error) {
    console.error(`Ошибка при получении данных: ${error.message}`);
    // Предпринять соответствующие действия
}
Use code with caution.
JavaScript
Если файл сегмента поврежден, WiseJSON попытается сообщить об этом с указанием пути к файлу.
Тестирование
WiseJSON поставляется с набором расширенных тестов для проверки основного функционала, включая CRUD-операции, сегментацию, работу очереди записи и обработку ошибок.
Для запуска тестов:
Убедитесь, что вы находитесь в корневой директории вашего проекта, где расположен файл advanced-test-wise-json.js и папка wise-json.
Выполните команду в терминале:
node advanced-test-wise-json.js
Use code with caution.
Bash
Тестовый скрипт создаст временную директорию test_db_data_advanced для своих нужд и (по умолчанию) не удаляет ее после завершения, чтобы можно было изучить структуру созданных файлов. Вы можете раскомментировать строку await cleanupTestDB(); в конце файла advanced-test-wise-json.js для автоматической очистки после тестов.
Тесты используют встроенный модуль assert Node.js.
Ограничения и Рекомендации
Транзакции между коллекциями: WiseJSON не обеспечивает атомарные транзакции, охватывающие несколько коллекций или несколько последовательных операций как единое целое. Ответственность за обеспечение консистентности данных при таких сценариях (например, через компенсирующие операции или паттерн "Сага") ложится на приложение-пользователь. WiseJSON гарантирует надежность и последовательность отдельных операций записи внутри одной коллекции.
Ссылочная целостность: Проверка ссылочной целостности (аналог foreign keys в SQL) не поддерживается и должна реализовываться на уровне приложения, если это необходимо.
Одновременный доступ из нескольких процессов: WiseJSON не предназначена для одновременной модификации одной и той же базы данных (одного dbRootPath) из нескольких независимых процессов Node.js. Это может привести к конфликтам записи и повреждению данных. Для таких сценариев рекомендуется использовать WiseJSON в рамках одного серверного процесса, который монопольно управляет доступом к данным, либо реализовывать внешние механизмы блокировки на уровне файловой системы.
Производительность: WiseJSON спроектирована с упором на простоту и надежность файлового хранения. Для приложений с очень высокими нагрузками или экстремально большими наборами данных специализированные СУБД могут быть более производительными. Операции чтения, требующие сканирования всех данных коллекции (например, find без специфичных индексов, которых нет), могут замедляться с ростом числа сегментов и общего объема данных.
Резервное копирование: Регулярно создавайте резервные копии всей корневой директории вашей базы данных WiseJSON (dbRootPath).
Максимальный размер файла: Хотя сегментация помогает управлять размером отдельных файлов, учитывайте ограничения файловой системы на общее количество файлов в директории и общий размер дискового пространства.
Лицензия

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