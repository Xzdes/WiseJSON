# WiseJSON (Архитектура v2.1: In-Memory First, WAL, Чекпоинты и Индексы)

WiseJSON - это легковесная встраиваемая база данных на основе JSON-файлов для среды Node.js. Текущая версия реализует архитектуру **In-Memory First** с использованием **журнала упреждающей записи (WAL)**, механизма **чекпоинтов** и поддержкой **пользовательских индексов** для достижения высокой производительности операций чтения, повышенной отказоустойчивости данных и ускорения целевых запросов.

WiseJSON ориентирована на проекты, где требуется быстрое локальное хранилище данных с надежной записью и возможностью оптимизации запросов без необходимости администрирования внешних СУБД.

## Ключевые принципы архитектуры

*   **In-Memory First:** Все активные данные каждой коллекции хранятся в оперативной памяти, обеспечивая максимальную скорость для операций чтения.
*   **Write-Ahead Logging (WAL):** Каждая операция, изменяющая данные, сначала записывается в файл журнала (WAL). Это гарантирует, что даже при внезапном сбое системы операции не будут потеряны.
*   **Checkpoints (Контрольные точки):** Периодически или по триггеру, текущее состояние данных из оперативной памяти (включая метаданные об активных индексах) полностью сохраняется на диск в виде файлов чекпоинта.
*   **Индексы:** Поддержка создания простых и уникальных индексов по полям документов. Индексы хранятся в памяти и автоматически обновляются при CRUD-операциях. Определения индексов персистентны (сохраняются в чекпоинтах и восстанавливаются при запуске, после чего индексы перестраиваются по загруженным данным).
*   **Надежность и автоматическое восстановление:** При запуске, WiseJSON восстанавливает свое состояние, загружая последний валидный чекпоинт (включая определения индексов), "накатывая" на него все последующие операции из WAL, и затем перестраивая индексы в памяти.
*   **Последовательное выполнение операций записи:** Для обеспечения консистентности данных, все операции, изменяющие данные одной коллекции и ее индексы, а также операции создания чекпоинта, выполняются строго последовательно через внутреннюю очередь.

## Основные возможности

*   **Высокопроизводительное чтение:** Быстрый доступ к данным благодаря хранению в оперативной памяти.
*   **Ускорение запросов с помощью индексов:** Возможность создавать простые и уникальные индексы по полям для значительного ускорения поиска по этим полям (через специальные методы или, в будущем, через оптимизатор запросов).
*   **Автоматическое обновление индексов:** Индексы в памяти автоматически поддерживаются в актуальном состоянии при операциях `insert`, `update`, `remove`, `upsert`, `clear`.
*   **Проверка уникальности:** Уникальные индексы гарантируют, что значения в индексированном поле не будут повторяться (проверка происходит до записи в WAL).
*   **Персистентность определений индексов:** Информация о созданных индексах сохраняется и восстанавливается при перезапусках, после чего индексы перестраиваются по актуальным данным.
*   **Отказоустойчивая запись данных:** Использование WAL и чекпоинтов повышает устойчивость к потерям данных.
*   **Автоматическое восстановление данных и индексов:** Система автоматически восстанавливает последнее согласованное состояние при старте.
*   **Гибкое управление чекпоинтами и индексами:** API для ручного сохранения, создания и удаления индексов.
*   **Минимальные внешние зависимости:** Написана на чистом JavaScript (CommonJS), использует только встроенные модули Node.js и `uuid` (по умолчанию).
*   **Широкие возможности конфигурации:** Настройка WAL, чекпоинтов, форматирования JSON, генерации ID.
*   **Система событий (хуков):** Поддержка подписки на события `afterInsert`, `afterUpdate`, `afterRemove`, `afterClear`.

## Установка

1.  **Скопируйте файлы библиотеки:**
    Поместите директорию `wise-json` (содержащую `index.js`, `collection.js`, `wal-manager.js`, `checkpoint-manager.js`, `storage-utils.js`) в ваш проект.

2.  **Установите зависимость `uuid`:**
    ```bash
    npm install uuid
    # или yarn add uuid
    ```

## Использование

### 1. Инициализация WiseJSON

```javascript
const path = require('path');
const WiseJSON = require('./path/to/wise-json/index.js');

const dbStoragePath = path.resolve(__dirname, 'my_app_db');

const dbOptions = {
    jsonIndent: 2,
    checkpointIntervalMs: 5 * 60 * 1000, 
    maxWalEntriesBeforeCheckpoint: 1000,
    walForceSync: false, 
    checkpointsToKeep: 3, 
};

const db = new WiseJSON(dbStoragePath, dbOptions);

db.baseDirInitPromise
    .then(() => console.log('WiseJSON: Базовая директория готова.'))
    .catch(err => { console.error('WiseJSON: Ошибка инициализации!', err); process.exit(1); });
```

### 2. Работа с Коллекциями и Индексами

```javascript
async function manageUsers() {
    let usersCollection;
    try {
        usersCollection = await db.collection('users', {
            // Опции специфичные для коллекции 'users'
            // maxWalEntriesBeforeCheckpoint: 500 
        });
        console.log(`Коллекция 'users' готова. Документов: ${await usersCollection.count()}`);

        // Создание индексов (лучше делать один раз при настройке приложения или проверять их наличие)
        // Индексы перестраиваются при запуске, если их метаданные были сохранены в чекпоинте.
        const currentIndexes = await usersCollection.getIndexes();
        if (!currentIndexes.find(idx => idx.fieldName === 'email')) {
            await usersCollection.createIndex('email', { unique: true });
            console.log("Уникальный индекс по 'email' создан.");
        }
        if (!currentIndexes.find(idx => idx.fieldName === 'city')) {
            await usersCollection.createIndex('city'); // Простой индекс
            console.log("Простой индекс по 'city' создан.");
        }
        
        // Вставка данных
        await usersCollection.insert({ name: 'Alice', email: 'alice@example.com', city: 'New York' });
        await usersCollection.insert({ name: 'Bob', email: 'bob@example.com', city: 'London' });
        
        // Поиск с использованием индекса (через специальные методы)
        const alice = await usersCollection.findOneByIndexedValue('email', 'alice@example.com');
        console.log('Найдена Alice по индексу email:', alice);

        const newYorkers = await usersCollection.findByIndexedValue('city', 'New York');
        console.log('Жители Нью-Йорка (по индексу city):', newYorkers);

        // Обычный поиск (полный скан по данным в памяти)
        const aliceAgain = await usersCollection.findOne(doc => doc.name === 'Alice');
        console.log('Найдена Alice обычным поиском:', aliceAgain);

    } catch (error) {
        console.error('Ошибка при работе с коллекцией users:', error);
    } finally {
        if (db) {
            // await db.close(); // Закрывать при завершении всего приложения
        }
    }
}
// initializeAppLogic().then(() => manageUsers()); // Пример вызова
```

### 3. API Коллекции (`Collection`)

Методы экземпляра `Collection` (все асинхронны):

*   **CRUD операции (индексы обновляются автоматически):**
    *   `async insert(dataObject)`
    *   `async update(id, updatesObject)`
    *   `async remove(id)`
    *   `async upsert(query, dataToUpsert, [upsertOptions])`
    *   `async clear()`
*   **Операции чтения (используют данные в памяти, могут использовать индексы через спец. методы):**
    *   `async getById(id)`
    *   `async getAll()`
    *   `async find(queryFunction)` (полный скан)
    *   `async findOne(queryFunction)` (полный скан)
    *   `async count([queryFunction])`
*   **Управление индексами:**
    *   `async createIndex(fieldName, options = { unique: false })`: Создает (или перестраивает) индекс по полю. `options.unique` (boolean) указывает, должен ли индекс быть уникальным. При создании уникального индекса существующие данные проверяются на уникальность. Определения индексов сохраняются в чекпоинтах.
    *   `async dropIndex(fieldName)`: Удаляет индекс. Изменение также отражается в чекпоинтах.
    *   `async getIndexes()`: Возвращает массив объектов с информацией об активных индексах (`{fieldName, type, entries}`).
*   **Поиск с использованием индексов (экспериментальные):**
    *   `async findOneByIndexedValue(fieldName, value)`: Быстрый поиск одного документа по точному значению в индексированном поле.
    *   `async findByIndexedValue(fieldName, value)`: Быстрый поиск всех документов по точному значению в индексированном поле.
*   **Управление состоянием и статистика:**
    *   `async save()`: Принудительно создает чекпоинт.
    *   `async getCollectionStats()`: Возвращает статистику (включая информацию об индексах).
    *   `async close()`: (Обычно вызывается через `db.close()`).
*   **События:**
    *   `on(eventName, listenerFunction)`
    *   `off(eventName, [listenerFunction])`
    *   Поддерживаемые события: `'afterInsert'`, `'afterUpdate'`, `'afterRemove'`, `'afterClear'`.

### 4. Завершение работы

Всегда вызывайте `await db.close()` перед завершением вашего приложения для гарантии сохранения всех данных.

## Архитектура и Надежность (Детали)

*   **In-Memory First:** Данные активных коллекций находятся в ОЗУ для быстрого чтения.
*   **Write-Ahead Log (WAL):** Файл `collectionName.wal.jsonl`. Операции изменения сначала пишутся сюда. При запуске WAL используется для восстановления данных после последнего чекпоинта.
*   **Checkpoints:** Данные из памяти периодически сохраняются в директорию `_checkpoints/` внутри папки коллекции. Каждый чекпоинт состоит из:
    *   **Мета-файла (`checkpoint_meta_collectionName_TIMESTAMP.json`):** Содержит временную метку, список файлов-сегментов данных, общее число документов и **определения активных индексов** (`{fieldName, type}`).
    *   **Файлов-сегментов данных (`checkpoint_data_collectionName_TIMESTAMP_segN.json`):** Содержат сами документы.
    "Публикация" чекпоинта происходит через атомарное переименование временного мета-файла в финальный.
*   **Индексы:**
    *   Хранятся в памяти (`Map`).
    *   Определения индексов (имя поля, тип) сохраняются в мета-файле чекпоинта.
    *   При запуске, после загрузки документов, индексы **перестраиваются в памяти** на основе этих определений и загруженных данных.
    *   Уникальные индексы проверяются на нарушение уникальности *перед* записью операции в WAL.
*   **Восстановление:** Загрузка последнего валидного чекпоинта -> Применение операций из WAL, которые новее этого чекпоинта -> Перестроение индексов.
*   **Очередь Записи:** Все операции записи и создания чекпоинтов для одной коллекции выполняются последовательно.

## Опции конфигурации (Детально)

Передаются в `new WiseJSON(path, globalOptions)` или `db.collection(name, collectionOptions)`.

*   `jsonIndent: number | null` (default: `2`): Отступ для JSON в файлах чекпоинтов.
*   `idGenerator: () => string` (default: `uuidv4`): Функция генерации `_id`.
*   `maxSegmentSizeBytes: number` (default: `1MB`): Макс. размер сегмента данных в чекпоинте.
*   `checkpointIntervalMs: number` (default: `5 минут`): Интервал авто-чекпоинтов. `0` или `Infinity` для отключения.
*   `maxWalEntriesBeforeCheckpoint: number` (default: `1000`): Лимит записей WAL до авто-чекпоинта. `0` или `Infinity` для отключения.
*   `walForceSync: boolean` (default: `false`): Форсировать `fs.sync()` для каждой записи WAL.
*   `checkpointsToKeep: number` (default: `2`): Количество последних чекпоинтов для хранения (минимум `1`).

## Обработка ошибок

*   Асинхронные методы возвращают Промисы, отклоняемые при ошибке.
*   Сообщения об ошибках обычно имеют префиксы для идентификации модуля.
*   Ошибки инициализации (`db.baseDirInitPromise`, `collection.initPromise`) критичны.
*   Ошибки обновления индексов в памяти после успешной записи в WAL логируются как критические (могут привести к рассинхронизации индекса), но на данном этапе не откатывают саму операцию.

## Тестирование

Смотрите файл `test/full-test-wise-json.js` для примеров комплексного тестирования.

## Ограничения и Рекомендации

*   **In-Memory:** Требуется достаточно ОЗУ для хранения данных активных коллекций.
*   **Индексы:** Текущая реализация перестраивает индексы при запуске. Для очень больших коллекций и множества индексов это может занимать время. Данные самих индексов пока не сохраняются персистентно (только их определения).
*   **Запросы по индексам:** Для использования индексов пока требуются специальные методы (`findOneByIndexedValue`, `findByIndexedValue`). Общие `find`/`findOne` выполняют полный скан по данным в памяти.
*   **Транзакции между коллекциями:** Не поддерживаются.
*   **Доступ из нескольких процессов:** **Не предназначен** для одновременной модификации БД из разных процессов Node.js.
*   **Резервное копирование:** Регулярно создавайте полные резервные копии директории `dbRootPath`.

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