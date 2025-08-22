# 📦 WiseJSON DB

![WiseJSON Логотип](logo.png)

[![NPM Version](https://img.shields.io/npm/v/wise-json-db.svg)](https://npmjs.org/package/wise-json-db)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js CI](https://github.com/Xzdes/WiseJSON/actions/workflows/nodejs.yml/badge.svg)](https://github.com/Xzdes/WiseJSON/actions/workflows/nodejs.yml)
[![Docker Hub](https://img.shields.io/badge/Docker%20Hub-ваш_логин%2Fwisejson--server-blue)](https://hub.docker.com/r/ваш_логин/wisejson-server)

**WiseJSON DB** — это невероятно быстрая, отказоустойчивая встраиваемая JSON-база данных для Node.js. Она включает мощный движок синхронизации, ACID-транзакции и продвинутое индексирование, что делает ее идеальным выбором для **offline-first** приложений, десктопного ПО и надежных бэкенд-сервисов.

---

## 🚀 Быстрый старт с Docker

Самый быстрый способ начать работу — запустить сервер WiseJSON, который включает веб-интерфейс **Data Explorer** и API для синхронизации, с помощью Docker.

**1. Запустите официальный Docker-образ:**
```bash
docker run -d -p 3000:3000 \
  -v wisejson_data:/data \
  --name wisejson-server \
  ваш_логин_dockerhub/wisejson-server:latest
```
*(Замените `ваш_логин_dockerhub` на реальное имя репозитория на Docker Hub)*

**2. Откройте Data Explorer:**
Ваш сервер запущен! Перейдите по адресу **[http://localhost:3000](http://localhost:3000)** в вашем браузере.

Файлы вашей базы данных надежно хранятся в Docker-томе (volume) с именем `wisejson_data`.

➡️ Подробные инструкции по конфигурации, сохранению данных и использованию Docker Compose вы найдете в нашем **[Полном руководстве по Docker](DOCKER.ru.md)**.

---

## 💡 Ключевые особенности

*   **Высокая производительность:** Индексирование в памяти и оптимизированный ввод-вывод для мгновенного доступа к данным.
*   **Отказоустойчивость и Надежность:**
    *   **WAL (Write-Ahead Logging):** Гарантирует целостность и восстановление данных после сбоев.
    *   **Атомарные Чекпоинты:** Периодические снимки состояния для быстрого перезапуска, с сегментацией для больших коллекций.
*   **ACID-транзакции:** Обеспечивают консистентность данных при операциях с несколькими коллекциями.
*   **Мощные запросы и Индексы:** Поддержка уникальных и неуникальных индексов, а также богатый синтаксис запросов (`$gt`, `$in`, `$or` и т.д.) для сложных выборок.
*   **Готовность к Offline-First:** Надежный движок для бесшовной синхронизации локальных данных клиента с центральным сервером.
*   **Встроенные инструменты:** Поставляется с веб-интерфейсом **Data Explorer** и универсальным **Интерфейсом командной строки (CLI)**.
*   **Безопасность при многопроцессной работе:** Использует файловые блокировки для предотвращения гонок данных при доступе из нескольких процессов Node.js.
*   **Легковесность и Простой API:** Минимальное количество зависимостей (`uuid`, `proper-lockfile`) и интуитивный, современный API.

---

## 📥 Установка (Как библиотека Node.js)

Чтобы встроить WiseJSON DB непосредственно в ваше Node.js-приложение, установите библиотеку из NPM:

```bash
npm install wise-json-db
```

---

## 📚 Основное использование API

API спроектирован так, чтобы быть простым и интуитивно понятным, с "ленивой" инициализацией.

```javascript
const { connect } = require('wise-json-db');
const path = require('path');

// `connect` создает экземпляр БД. Инициализация происходит автоматически при первой операции.
const db = connect(path.resolve(__dirname, 'my-app-data'));

async function main() {
  // Получение коллекции запускает инициализацию, если она еще не произошла.
  const users = await db.getCollection('users');
  
  await users.clear(); // Очистим для предсказуемого результата

  // Создаем уникальный индекс для предотвращения дубликатов email
  await users.createIndex('email', { unique: true });

  // Вставка документов
  await users.insert({ name: 'Алиса', email: 'alice@example.com', age: 30 });
  await users.insertMany([
    { name: 'Борис', email: 'bob@example.com', age: 24 },
    { name: 'Вера', email: 'vera@example.com', age: 35, tags: ['dev'] }
  ]);

  // Поиск документа с помощью многофункционального объекта-фильтра
  const devUser = await users.findOne({ tags: 'dev', age: { $gt: 30 } });
  console.log('Разработчик старше 30:', devUser);

  // Обновление документа с помощью операторов в стиле MongoDB
  const { modifiedCount } = await users.updateOne(
    { email: 'alice@example.com' },
    { $set: { status: 'active' }, $inc: { age: 1 } }
  );
  console.log(`Обновлено ${modifiedCount} документ(ов).`);
  
  // Закрываем БД, чтобы гарантировать сохранение всех данных на диск перед выходом из приложения.
  await db.close();
  console.log('База данных закрыта.');
}

main().catch(console.error);```

Для более глубокого изучения API обратитесь к документации в директории `/docs`.

---

## 🛠️ Интерфейс командной строки (CLI)

WiseJSON DB включает мощный CLI для администрирования базы данных.

```bash
# Показать все доступные команды
wise-json --help

# Список всех коллекций в базе данных
wise-json list-collections

# Показать документы с фильтрацией и сортировкой
wise-json show-collection users --limit 5 --sort age --order desc

# Создать индекс (требует флаг --allow-write для изменяющих операций)
wise-json create-index users email --unique --allow-write```

---
## 🤝 Вклад в разработку

Мы приветствуем ваш вклад! Будь то отчеты об ошибках, предложения по улучшению функционала или pull-реквесты, ваша помощь будет оценена. Пожалуйста, не стесняйтесь открывать issue для обсуждения ваших идей.

## 📄 Лицензия

Проект распространяется под лицензией MIT. См. файл `LICENSE` для подробностей.