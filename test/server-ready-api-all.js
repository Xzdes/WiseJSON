// test/server-ready-api.test.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Импортируем все, что нам нужно, из корневого модуля
const { connect, UniqueConstraintError } = require('../index.js');

// --- Настройка тестового окружения ---
const TEST_DB_PATH = path.resolve(__dirname, 'server-api-test-db');

/**
 * Вспомогательная функция для полной очистки тестовой директории.
 */
function cleanup() {
    if (fs.existsSync(TEST_DB_PATH)) {
        fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}

// --- Основной блок теста ---
async function runServerReadyApiTest() {
    console.log('=== SERVER-READY API TEST START ===');
    // Гарантированная очистка перед началом
    cleanup();
    let db;

    try {
        // 1. Проверяем "ленивую" инициализацию. НЕ вызываем db.init()
        console.log('  [1] Инициализация DB без явного вызова .init()');
        db = connect(TEST_DB_PATH);
        assert.ok(db, 'Экземпляр DB должен быть создан');

        // 2. Используем новый метод getCollection()
        console.log('  [2] Получение коллекции через getCollection()');
        const users = await db.getCollection('users');
        assert.ok(users, 'Коллекция "users" должна быть получена');
        assert.strictEqual(await users.count(), 0, 'Новая коллекция должна быть пустой');

        // 3. Базовые операции
        console.log('  [3] Тестирование базовых CRUD-операций');
        await users.insert({ _id: 'user1', name: 'Alice', email: 'alice@example.com' });
        const alice = await users.getById('user1');
        assert.strictEqual(alice.name, 'Alice', 'getById должен найти Alice');
        assert.strictEqual(await users.count(), 1, 'Количество должно быть 1');

        // 4. Проверка кастомной ошибки UniqueConstraintError
        console.log('  [4] Тестирование кастомной ошибки UniqueConstraintError');
        await users.createIndex('email', { unique: true });
        
        await assert.rejects(
            async () => {
                await users.insert({ name: 'Alicia', email: 'alice@example.com' });
            },
            (err) => {
                // Проверяем, что это ошибка нужного типа и содержит правильные данные
                assert(err instanceof UniqueConstraintError, 'Ошибка должна быть типа UniqueConstraintError');
                assert.strictEqual(err.fieldName, 'email', 'Поле ошибки должно быть "email"');
                assert.strictEqual(err.value, 'alice@example.com', 'Значение ошибки должно быть "alice@example.com"');
                return true; // Если все assert внутри прошли, возвращаем true
            },
            'Должна быть выброшена ошибка UniqueConstraintError при дублировании email'
        );
        console.log('  --- UniqueConstraintError успешно поймана');

        // 5. Проверка работы с несколькими коллекциями
        console.log('  [5] Работа с несколькими коллекциями');
        const logs = await db.getCollection('logs');
        await logs.insert({ event: 'user_created', userId: 'user1' });
        assert.strictEqual(await logs.count(), 1, 'Коллекция логов должна содержать 1 запись');

        const collectionNames = await db.getCollectionNames();
        assert.deepStrictEqual(collectionNames.sort(), ['logs', 'users'].sort(), 'getCollectionNames должен вернуть правильный список');

    } finally {
        // 6. Гарантированное закрытие БД и очистка
        console.log('  [6] Закрытие БД и очистка временных файлов');
        if (db) {
            await db.close();
        }
        cleanup();
        console.log('  --- Очистка завершена');
    }

    console.log('\n✅ === SERVER-READY API TEST PASSED SUCCESSFULLY ===');
}

// Запускаем тест
runServerReadyApiTest().catch(err => {
    console.error('\n🔥 === TEST FAILED ===');
    console.error(err);
    // Все равно пытаемся очистить файлы в случае ошибки
    cleanup();
    process.exit(1);
});