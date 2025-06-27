```markdown
# 00 - Введение и Настройка

Добро пожаловать в WiseJSON DB — быструю, надежную и простую в использовании встраиваемую JSON-базу данных для Node.js. Она разработана для высокой производительности и сохранности данных благодаря механизмам журналирования (WAL), чекпоинтов, атомарных транзакций и поддержки индексов.

Этот документ поможет вам быстро начать работу с WiseJSON DB.

## Ключевые концепции

*   **База данных (Database):** Физическое хранилище на диске, представленное одной директорией. Содержит одну или несколько коллекций.
*   **Коллекция (Collection):** Аналог таблицы в SQL или коллекции в MongoDB. Это именованная группа JSON-документов.
*   **Документ (Document):** Отдельная запись в коллекции, представленная JavaScript-объектом. Каждый документ имеет уникальное поле `_id`.

## Установка

Установите пакет с помощью npm или yarn:

```bash
npm install wise-json-db
# или
yarn add wise-json-db
```
Это установит пакет `wise-json-db` и все необходимые зависимости (`uuid`, `proper-lockfile`).

## Быстрый старт

Этот пример показывает полный цикл работы: инициализация, создание, чтение, обновление и удаление данных.

```javascript
// Подключаем библиотеку
const WiseJSON = require('wise-json-db');
const path = require('path');

async function main() {
    // 1. Указываем путь, где будет храниться база данных.
    const dbPath = path.resolve(__dirname, 'myAppData');

    // 2. Создаем или открываем экземпляр БД и дожидаемся его инициализации.
    const db = new WiseJSON(dbPath);
    await db.init();

    // 3. Получаем (или создаем) коллекцию 'users' и ждем ее готовности.
    const users = await db.collection('users');
    await users.initPromise;
    
    // Для чистоты примера очистим коллекцию перед началом
    await users.clear();

    // 4. Вставляем документы
    await users.insert({ name: 'Alice', age: 30, city: 'New York' });
    await users.insertMany([
        { name: 'Bob', age: 25, city: 'London' },
        { name: 'Charlie', age: 35, city: 'New York' }
    ]);
    console.log(`После вставки в коллекции ${await users.count()} документа.`);

    // 5. Ищем документы
    const userBob = await users.findOne({ name: 'Bob' });
    console.log('Найден Bob:', userBob);

    const usersFromNY = await users.find({ city: 'New York' });
    console.log(`Пользователей из New York: ${usersFromNY.length}`);

    // 6. Обновляем документ
    if (userBob) {
        await users.update(userBob._id, { age: 26, status: 'active' });
        const updatedBob = await users.getById(userBob._id);
        console.log('Обновленный Bob:', updatedBob);
    }

    // 7. Удаляем документ
    const charlie = await users.findOne({ name: 'Charlie' });
    if (charlie) {
        await users.remove(charlie._id);
        console.log(`Пользователь Charlie удален. Осталось документов: ${await users.count()}`);
    }

    // 8. Обязательно закрываем БД для сохранения всех изменений.
    await db.close();
    console.log('База данных закрыта.');
}

main().catch(console.error);
```

## Структура публичного API

Основной экспорт пакета `wise-json-db` предоставляет доступ к ключевым классам и функциям:

```javascript
const {
  WiseJSON,          // Основной класс базы данных
  Collection,        // Класс коллекции (для type hinting или расширения)
  SyncManager,       // Менеджер синхронизации (для продвинутых сценариев)
  // и другие утилиты...
} = require('wise-json-db');
```

### `new WiseJSON(dbPath, [options])`

Конструктор для создания экземпляра БД.

*   `dbPath {string}`: Путь к корневой директории базы данных.
*   `options {object}` (необязательно): Объект для тонкой настройки.

### Методы экземпляра `db`

*   **`await db.init()`**: Асинхронно инициализирует базу данных. **Обязательно вызывать** после создания экземпляра.
*   **`await db.collection(name)`**: Возвращает экземпляр коллекции. Не забывайте дожидаться `collection.initPromise`.
*   **`await db.close()`**: Корректно закрывает базу данных, сохраняя все несохраненные данные и снимая блокировки. **Обязательно вызывать** перед завершением работы приложения.
*   **`db.beginTransaction()`**: Начинает новую транзакцию.

### Основные методы коллекции

| Метод                          | Описание                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `await collection.insert(doc)`     | Вставить один документ.                                                      |
| `await collection.insertMany(docs)`| Вставить массив документов.                                                  |
| `await collection.find(filter)`    | Найти все документы, соответствующие фильтру (объект-запрос).                |
| `await collection.findOne(filter)` | Найти первый документ, соответствующий фильтру.                              |
| `await collection.update(id, data)`| Частично обновить документ по его `_id`.                                     |
| `await collection.updateMany(filter, update)`| Обновить все документы по фильтру (используя операторы `$set`, `$inc`). |
| `await collection.remove(id)`      | Удалить документ по его `_id`.                                               |
| `await collection.deleteMany(filter)` | Удалить все документы, соответствующие фильтру.                               |
| `await collection.count()`         | Посчитать количество документов в коллекции.                                 |
| `await collection.clear()`         | Удалить все документы из коллекции.                                          |

> **Примечание:** `filter` для `find`, `findOne` и `deleteMany` — это объект, описывающий условия поиска, аналогично MongoDB (например, `{ age: { $gt: 25 } }`).

## Дальнейшие шаги

Теперь, когда вы знакомы с основами, вы можете перейти к более детальному изучению:

*   **[01 - Работа с Коллекциями и Документами](01-collections-and-documents.md)**
*   **[02 - Запросы к Данным и Индексирование](02-querying-and-indexing.md)**
*   **[03 - Работа с Транзакциями](03-transactions.md)**
*   **[04 - Расширенные Возможности и Конфигурация](04-advanced-features.md)**