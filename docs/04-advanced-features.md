```markdown
docs/04-advanced-features.md
# 04 - Расширенные Возможности и Конфигурация

В этом разделе рассматриваются дополнительные возможности WiseJSON DB, которые позволяют тонко настроить поведение базы данных, управлять данными через командную строку (CLI) и выполнять операции импорта/экспорта.

## Конфигурация Экземпляра `WiseJSON`

При создании нового экземпляра `WiseJSON` вы можете передать второй аргумент — объект с опциями конфигурации, чтобы адаптировать базу данных под нужды вашего приложения.

**Синтаксис:**
`const db = new WiseJSON(dbPath, options);`

### Основные доступные опции:

*   **`ttlCleanupIntervalMs {number}`**
    *   **Описание:** Интервал в миллисекундах, с которым база данных будет автоматически проверять и удалять документы с истекшим сроком жизни (TTL).
    *   **По умолчанию:** `60000` (1 минута).
    *   **Пример:** `3600000` для проверки раз в час.

*   **`checkpointIntervalMs {number}`**
    *   **Описание:** Интервал в миллисекундах для автоматического создания чекпоинтов (снапшотов данных). Чекпоинты ускоряют запуск и восстановление.
    *   **По умолчанию:** `300000` (5 минут).
    *   **Пример:** `0` чтобы отключить создание чекпоинтов по таймеру.

*   **`maxWalEntriesBeforeCheckpoint {number}`**
    *   **Описание:** Максимальное количество записей в журнале упреждающей записи (WAL), после которого будет принудительно запущен процесс создания чекпоинта, независимо от таймера.
    *   **По умолчанию:** `1000`.

*   **`checkpointsToKeep {number}`**
    *   **Описание:** Количество последних чекпоинтов, которые будут храниться на диске. Более старые будут автоматически удаляться для экономии места.
    *   **По умолчанию:** `5`.
    *   **Минимальное значение:** `1`.

*   **`idGenerator {function}`**
    *   **Описание:** Пользовательская функция для генерации `_id` документов, если `_id` не предоставлен при вставке. Должна возвращать уникальную строку.
    *   **По умолчанию:** Функция, генерирующая `uuid v4`.
    *   **Пример:** `() => \`doc-\${Date.now()}\``

*   **`walReadOptions {object}`**
    *   **Описание:** Опции для обработки WAL-файлов при запуске, особенно если они повреждены.
    *   **По умолчанию:** `{ recover: false, strict: false }`. В этом режиме поврежденные строки WAL пропускаются с выводом предупреждения.
    *   **Опции:**
        *   `recover: true`: Агрессивно пытаться восстановить данные, пропуская битые строки WAL.
        *   `strict: true`: Выбрасывать ошибку при первой же ошибке парсинга строки WAL, останавливая инициализацию.

**Пример использования опций:**

```javascript
const { v4: uuidv4 } = require('uuid');

const dbOptions = {
  checkpointIntervalMs: 10 * 60 * 1000, // Чекпоинт каждые 10 минут
  checkpointsToKeep: 3,                 // Хранить 3 последних чекпоинта
  idGenerator: () => `user-${uuidv4()}`,// Кастомный ID
  walReadOptions: { recover: true }     // Пытаться восстановить из поврежденного WAL
};

const db = new WiseJSON('/path/to/my-app-db', dbOptions);
```

## Импорт и Экспорт Данных (через API)

Вы можете легко переносить данные в/из коллекций с помощью встроенных методов.

*   **`collection.exportJson(filePath)`**: Сохраняет все "живые" документы коллекции в указанный файл в формате JSON (массив объектов).
    ```javascript
    await usersCollection.exportJson('./backups/users_backup.json');
    ```
*   **`collection.exportCsv(filePath, options)`**: Сохраняет данные в формате CSV. Можно настроить разделители и заголовки.
    ```javascript
    await usersCollection.exportCsv('./backups/users_backup.csv');
    ```
*   **`collection.importJson(filePath, options)`**: Импортирует документы из JSON-файла.
    *   `options.mode`:
        *   `'append'` (по умолчанию): Добавляет документы из файла к существующим в коллекции.
        *   `'replace'`: **Полностью очищает** коллекцию перед импортом документов из файла.
    ```javascript
    // Добавить новых пользователей из файла
    await usersCollection.importJson('./new_users.json');

    // Полностью заменить данные в коллекции
    await productsCollection.importJson('./full_product_list.json', { mode: 'replace' });
    ```

## Интерфейс Командной Строки (CLI)

WiseJSON DB включает мощный инструмент командной строки `wisejson-explorer` для администрирования базы данных без написания кода.

**Важно:**
*   **Путь к БД:** Укажите путь к вашей базе данных через переменную окружения `WISE_JSON_PATH`.
*   **Разрешение на запись:** Для выполнения команд, изменяющих данные (`import`, `create-index`, `doc-remove` и др.), необходимо использовать глобальный флаг `--allow-write`.

**Примеры команд:**

### Команды для чтения и анализа данных

*   **`list-collections`**: Показать все коллекции и количество документов в них.
    ```bash
    wisejson-explorer list-collections
    ```
*   **`show-collection <collectionName>`**: Показать документы в коллекции с фильтрацией, сортировкой и пагинацией.
    ```bash
    # Показать первые 5 документов из 'users', отсортированных по возрасту (по убыванию)
    wisejson-explorer show-collection users --limit 5 --sort age --order desc

    # Найти пользователей старше 30 с помощью JSON-фильтра
    wisejson-explorer show-collection users --filter '{"age":{"$gt":30}}'
    ```
*   **`get-document <collectionName> <documentId>`**: Получить один документ по его `_id`.
*   **`collection-stats <collectionName>`**: Показать детальную статистику коллекции.
*   **`export-collection <collectionName> <filename>`**: Экспортировать коллекцию в файл (JSON по умолчанию, CSV через опцию).
    ```bash
    wisejson-explorer export-collection users users_backup.csv --output csv
    ```

### Команды для управления данными (требуют `--allow-write`)

*   **`doc-insert <collectionName> '<json_string>'`**: Вставить один новый документ. JSON-строку необходимо заключать в кавычки.
    ```bash
    wisejson-explorer doc-insert users '{"name":"Новый Пользователь","age":99}' --allow-write
    ```
*   **`doc-remove <collectionName> <documentId>`**: Удалить документ по `_id`.
    ```bash
    wisejson-explorer doc-remove users 'user-id-123' --allow-write
    ```
*   **`import-collection <collectionName> <filename>`**: Импортировать документы из JSON-файла.
    ```bash
    # Заменить все документы в коллекции на данные из файла
    wisejson-explorer import-collection users new_users.json --mode replace --allow-write
    ```
*   **`collection-clear <collectionName>`**: **НЕОБРАТИМО** удалить все документы из коллекции.
    ```bash
    wisejson-explorer collection-clear old_logs --allow-write
    ```
*   **`collection-drop <collectionName>`**: **НЕОБРАТИМО** удалить всю коллекцию.
    ```bash
    wisejson-explorer collection-drop temp_data --allow-write --force
    ```

### Команды для управления индексами (требуют `--allow-write`)

*   **`list-indexes <collectionName>`**: Показать список индексов для коллекции.
*   **`create-index <collectionName> <fieldName>`**: Создать индекс.
    ```bash
    # Создать стандартный индекс по полю city
    wisejson-explorer create-index users city --allow-write

    # Создать уникальный индекс по полю email
    wisejson-explorer create-index users email --unique --allow-write
    ```
*   **`drop-index <collectionName> <fieldName>`**: Удалить индекс.

## Data Explorer (Веб-интерфейс)

Для визуального просмотра и управления данными вы можете запустить встроенный веб-интерфейс.

*   **Запуск**: `wisejson-explorer-server` или `node explorer/server.js`
*   **Включение режима записи**: Чтобы иметь возможность удалять документы и управлять индексами через веб-интерфейс, установите переменную окружения `WISEJSON_EXPLORER_ALLOW_WRITE=true` перед запуском сервера.
    ```bash
    # Linux/macOS
    WISEJSON_EXPLORER_ALLOW_WRITE=true wisejson-explorer-server

    # Windows (CMD)
    set WISEJSON_EXPLORER_ALLOW_WRITE=true&&wisejson-explorer-server
    ```
Это позволит вам выполнять операции записи прямо из браузера.