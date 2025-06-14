```markdown
docs/04-advanced-features.md
# 04 - Расширенные Возможности и Конфигурация

В этом разделе рассматриваются дополнительные возможности WiseJSON DB, такие как настройка экземпляра базы данных, импорт и экспорт данных, а также подробное руководство по использованию интерфейса командной строки (CLI) для администрирования.

## Конфигурация Экземпляра `WiseJSON`

При создании нового экземпляра `WiseJSON` вы можете передать второй аргумент — объект с опциями конфигурации, чтобы настроить поведение базы данных под ваши нужды.

**Синтаксис:**
`const db = new WiseJSON(dbPath, options);`

**Основные доступные опции:**

*   **`ttlCleanupIntervalMs {number}`** (по умолч. `60000`): Интервал в миллисекундах для автоматической очистки документов с истекшим TTL.
*   **`checkpointIntervalMs {number}`** (по умолч. `300000`): Интервал для автоматического создания чекпоинтов.
*   **`maxWalEntriesBeforeCheckpoint {number}`** (по умолч. `1000`): Максимальное количество записей в WAL-файле перед принудительным созданием чекпоинта.
*   **`checkpointsToKeep {number}`** (по умолч. `5`): Количество последних чекпоинтов, которые будут храниться на диске.
*   **`idGenerator {function}`**: Пользовательская функция для генерации `_id` документов.
*   **`walReadOptions {object}`**: Опции для обработки поврежденных WAL-файлов при запуске. По умолчанию `{ recover: false, strict: false }`.

**Пример использования опций:**

```javascript
const { v4: uuidv4 } = require('uuid'); // Пример кастомного генератора

const dbOptions = {
  checkpointIntervalMs: 10 * 60 * 1000, // Чекпоинт каждые 10 минут
  checkpointsToKeep: 3,                 // Хранить 3 последних чекпоинта
  idGenerator: () => `doc-${uuidv4()}`, // Кастомный ID
  walReadOptions: { recover: true }     // Пытаться восстановить из поврежденного WAL
};

const db = new WiseJSON('/path/to/db', dbOptions);
```

## Импорт и Экспорт Данных (через API)

*   **`collection.exportJson(filePath)`**: Сохраняет все "живые" документы коллекции в указанный файл в формате JSON (массив объектов).
*   **`collection.exportCsv(filePath)`**: Сохраняет данные в формате CSV.
*   **`collection.importJson(filePath, options)`**: Импортирует документы из JSON-файла.
    *   `options.mode`: `'append'` (по умолчанию) или `'replace'` (очищает коллекцию перед импортом).

## Интерфейс Командной Строки (CLI)

WiseJSON DB включает два инструмента командной строки для удобного администрирования без написания кода.

**Важно:** Для выполнения команд, изменяющих данные, необходимо использовать глобальный флаг `--allow-write`.

### 1. `wisejson-explorer` (Продвинутый CLI и Data Explorer)

Это основной и наиболее мощный инструмент для работы с базой данных из командной строки.

**Основные моменты:**
*   **Путь к БД**: Укажите путь к вашей базе данных через переменную окружения `WISE_JSON_PATH`.
*   **Запуск**: `node explorer/cli.js <command> [options]` или `wisejson-explorer <command> [options]`, если пакет установлен глобально.

#### Команды для чтения данных

*   **`list-collections`**: Показать все коллекции и количество документов в них.
    ```bash
    wisejson-explorer list-collections
    ```
*   **`show-collection <collectionName>`**: Показать документы в коллекции с фильтрацией и сортировкой.
    ```bash
    # Показать первые 5 документов из 'users', отсортированных по возрасту (по убыванию)
    wisejson-explorer show-collection users --limit 5 --sort age --order desc

    # Найти пользователей старше 30 с помощью JSON-фильтра
    wisejson-explorer show-collection users --filter '{"age":{"$gt":30}}'
    ```
*   **`get-document <collectionName> <documentId>`**: Получить один документ по его `_id`.
*   **`collection-stats <collectionName>`**: Показать статистику коллекции (количество документов, операций) и список индексов.
*   **`list-indexes <collectionName>`**: Показать только список индексов для коллекции.
*   **`export-collection <collectionName> <filename>`**: Экспортировать коллекцию в файл.
    ```bash
    # Экспорт в JSON (по умолчанию)
    wisejson-explorer export-collection users users_backup.json

    # Экспорт в CSV
    wisejson-explorer export-collection users users_backup.csv --output csv
    ```

#### Команды для управления данными (требуют `--allow-write`)

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
    # Добавить документы к существующим
    wisejson-explorer import-collection users new_users.json --allow-write

    # Заменить все документы в коллекции на данные из файла
    wisejson-explorer import-collection users new_users.json --mode replace --allow-write
    ```
*   **`create-index <collectionName> <fieldName>`**: Создать индекс.
    ```bash
    # Создать стандартный индекс по полю city
    wisejson-explorer create-index users city --allow-write

    # Создать уникальный индекс по полю email
    wisejson-explorer create-index users email --unique --allow-write
    ```
*   **`drop-index <collectionName> <fieldName>`**: Удалить индекс.
*   **`collection-drop <collectionName>`**: **НЕОБРАТИМО** удалить всю коллекцию со всеми данными. Потребует подтверждения, если не используется флаг `--force`.
    ```bash
    wisejson-explorer collection-drop old_logs --allow-write --force
    ```

### 2. `wise-json` (Базовый CLI)

Этот инструмент предоставляет подмножество основного функционала и также был обновлен для использования нового API. Он может быть удобен для простых скриптов.

*   **`wise-json list`**: Список коллекций.
*   **`wise-json find <collectionName> '[filter]'`**: Поиск документов.
*   **`wise-json get <collectionName> <id>`**: Получить по ID.
*   **`wise-json insert <collectionName> '[doc]'`**: Вставить документ.
*   ... и другие. Для полного списка используйте `wise-json help`.

### Data Explorer (Веб-интерфейс)

Не забывайте про веб-интерфейс, который предоставляет удобный графический способ для просмотра и управления данными.
*   **Запуск**: `node explorer/server.js`
*   **Включение режима записи**: Установите переменную окружения `WISEJSON_EXPLORER_ALLOW_WRITE=true` перед запуском сервера.
    ```bash
    # Linux/macOS
    WISEJSON_EXPLORER_ALLOW_WRITE=true node explorer/server.js

    # Windows (CMD)
    set WISEJSON_EXPLORER_ALLOW_WRITE=true&&node explorer/server.js
    ```
Это позволит вам удалять документы и управлять индексами прямо из браузера.