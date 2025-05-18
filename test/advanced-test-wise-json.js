// advanced-test-wise-json.js
const WiseJSON = require('wise-json-db');
const path = require('path');
const fs = require('fs/promises');
const assert = require('assert').strict;
const { v4: uuidv4 } = require('uuid');

const TEST_DB_ROOT_ADVANCED = path.join(__dirname, 'test_db_data_advanced');

// --- Глобальные переменные для статистики ---
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failedTestDetails = [];

// --- Вспомогательная функция для запуска тестовых блоков ---
async function describe(description, fn) {
    console.log(`\n🧪 Описание: ${description}`);
    await fn();
}

// --- Вспомогательная функция для отдельных тестов ---
async function it(description, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✅ PASSED: ${description}`);
        passedTests++;
    } catch (error) {
        console.error(`  ❌ FAILED: ${description}`);
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`     Error: ${errorMessage}`);
        if (error.stack && error instanceof Error) {
            // console.error(`     Stack: ${error.stack.split('\n').slice(1).join('\n')}`);
        }
        failedTests++;
        failedTestDetails.push({ description, error: errorMessage, stack: error instanceof Error ? error.stack : null });
    }
}

// --- Функция для очистки тестовой директории ---
async function cleanupTestDB() {
    try {
        await fs.rm(TEST_DB_ROOT_ADVANCED, { recursive: true, force: true });
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('Предупреждение: Ошибка при очистке тестовой директории:', error.message);
        }
    }
}

// --- Основная тестовая функция ---
async function runAdvancedTests() {
    console.log('🚀 Запуск БОЕВЫХ тестов для WiseJSON (фокус на UPSERT)...\n');
    await cleanupTestDB(); 

    let db;

    // Обязательная инициализация DB перед тестами upsert
    console.log('\n🧪 Описание: Инициализация WiseJSON для тестов UPSERT');
    await it('должен успешно инициализировать WiseJSON и создать базовую директорию', async () => {
        db = new WiseJSON(TEST_DB_ROOT_ADVANCED);
        await db.baseDirInitPromise;
        await fs.access(TEST_DB_ROOT_ADVANCED);
        console.log("--- DEBUG: DB инициализирован ---");
    });
    
    if (!db || failedTests > 0) {
        console.error("\nКритическая ошибка на этапе инициализации DB. Тесты upsert не будут выполнены.");
        // Вывод итогов, если нужен, но основной фокус - почему не дошли до upsert
        console.log('\n\n--- Итоги Расширенных Тестов ---');
        console.log(`Всего тестов запущено: ${totalTests}`);
        console.log(`✅ Пройдено: ${passedTests}`);
        console.log(`❌ Провалено: ${failedTests > 0 ? failedTests : 1}`); // Если упали здесь, считаем 1 провал
        if (failedTests > 0 || totalTests === 0) { // Добавил totalTests === 0
            failedTestDetails.forEach(fail => {
                console.error(`\n  Описание: ${fail.description}\n  Ошибка: ${fail.error}`);
            });
             if(failedTestDetails.length === 0 && totalTests === 0) { // Если даже первый it не прошел
                console.error("\n  Критическая ошибка: Не удалось даже инициализировать DB для тестов.");
            }
        }
        return;
    }

    // ====================================================================================
    // Тестирование `upsert()` - ИЗОЛИРОВАННЫЙ БЛОК
    // ====================================================================================
    await describe('Метод upsert() в Collection', async () => {
        console.log("--- DEBUG UPSERT: Начало блока describe('Метод upsert()') ---");
        const upsertCollection = await db.collection('upsert_items_isolated_test');
        console.log("--- DEBUG UPSERT: Коллекция 'upsert_items_isolated_test' получена ---");

        await it('должен вставлять новый документ, если он не найден (query-объект)', async () => {
            console.log("---- DEBUG UPSERT it_insert_query_obj: Начало");
            const result = await upsertCollection.upsert(
                { email: 'upsert_new@example.com' }, 
                { name: 'Upsert New User', status: 'active' } 
            );
            console.log("---- DEBUG UPSERT it_insert_query_obj: upsert выполнен, result.operation:", result ? result.operation : 'null_result', "docId:", result && result.document ? result.document._id : 'N/A');
            assert.strictEqual(result.operation, 'inserted', 'Операция должна быть "inserted"');
            assert(result.document && result.document._id, 'Документ должен быть вставлен и иметь _id');
            assert.strictEqual(result.document.email, 'upsert_new@example.com', 'Поле из query должно быть в документе');
            assert.strictEqual(result.document.name, 'Upsert New User');
            console.log("---- DEBUG UPSERT it_insert_query_obj: Завершение");
        });

        let existingUserId;
        await it('должен обновлять существующий документ, если он найден (query-объект)', async () => {
            console.log("---- DEBUG UPSERT it_update_query_obj: Начало");
            // Сначала вставим документ, чтобы было что обновлять в этом изолированном тесте
            // Используем другую почту, чтобы не конфликтовать с предыдущим тестом, если он не очищает
            const preInsert = await upsertCollection.insert({ email: 'upsert_existing_for_update@example.com', name: 'Upsert Existing User', initialValue: 10 });
            existingUserId = preInsert._id;
            console.log("---- DEBUG UPSERT it_update_query_obj: preInsert выполнен, ID:", existingUserId);

            const result = await upsertCollection.upsert(
                { email: 'upsert_existing_for_update@example.com' }, 
                { status: 'inactive_upsert', age: 31 }
            );
            console.log("---- DEBUG UPSERT it_update_query_obj: upsert выполнен, result.operation:", result ? result.operation : 'null_result', "docId:", result && result.document ? result.document._id : 'N/A');
            assert.strictEqual(result.operation, 'updated', 'Операция должна быть "updated"');
            assert(result.document, 'Обновленный документ должен быть возвращен');
            assert.strictEqual(result.document._id, existingUserId, '_id не должен меняться');
            assert.strictEqual(result.document.email, 'upsert_existing_for_update@example.com');
            assert.strictEqual(result.document.name, 'Upsert Existing User', 'Необновленные поля должны остаться');
            assert.strictEqual(result.document.status, 'inactive_upsert', 'Поле status должно обновиться');
            assert.strictEqual(result.document.age, 31, 'Новое поле age должно добавиться');
            console.log("---- DEBUG UPSERT it_update_query_obj: Завершение");
        });

        await it('должен вставлять новый документ, если он не найден (query-функция)', async () => {
            console.log("---- DEBUG UPSERT it_insert_query_fn: Начало");
            const result = await upsertCollection.upsert(
                doc => doc.username === 'upsertUserFuncToInsert', // Уникальное имя
                { username: 'upsertUserFuncToInsert', role: 'editor_upsert_fn' }
            );
            console.log("---- DEBUG UPSERT it_insert_query_fn: upsert выполнен, result.operation:", result ? result.operation : 'null_result', "docId:", result && result.document ? result.document._id : 'N/A');
            assert.strictEqual(result.operation, 'inserted');
            assert(result.document && result.document.username === 'upsertUserFuncToInsert');
            assert.strictEqual(result.document.role, 'editor_upsert_fn');
            console.log("---- DEBUG UPSERT it_insert_query_fn: Завершение");
        });
        
        await it('должен обновлять существующий документ, если он найден (query-функция)', async () => {
            console.log("---- DEBUG UPSERT it_update_query_fn: Начало");
            // Вставим, если еще нет
            let userToUpdate = await upsertCollection.findOne(doc => doc.username === 'upsertUserFuncToUpdate');
            if (!userToUpdate) {
                userToUpdate = await upsertCollection.insert({ username: 'upsertUserFuncToUpdate', role: 'initial_role_fn_update' });
            }
            assert(userToUpdate, "Пользователь для обновления (query-fn) должен существовать");
            console.log("---- DEBUG UPSERT it_update_query_fn: Пользователь для обновления найден/создан, ID:", userToUpdate._id);

            const result = await upsertCollection.upsert(
                doc => doc.username === 'upsertUserFuncToUpdate',
                { role: 'admin_upsert_fn', lastLogin: new Date().toISOString() }
            );
            console.log("---- DEBUG UPSERT it_update_query_fn: upsert выполнен, result.operation:", result ? result.operation : 'null_result', "docId:", result && result.document ? result.document._id : 'N/A');
            assert.strictEqual(result.operation, 'updated');
            assert.strictEqual(result.document._id, userToUpdate._id);
            assert.strictEqual(result.document.role, 'admin_upsert_fn');
            assert(result.document.lastLogin, 'lastLogin должен быть добавлен');
            console.log("---- DEBUG UPSERT it_update_query_fn: Завершение");
        });

        await it('должен использовать setOnInsert при вставке и игнорировать при обновлении', async () => {
            console.log("---- DEBUG UPSERT it_set_on_insert: Начало");
            const upsertOptions = { setOnInsert: { initialPoints: 101, source: 'upsert_test_soi_isolated' } };
            
            console.log("---- DEBUG UPSERT it_set_on_insert: Перед первой вставкой (key1_soi_isolated)");
            const insertResult = await upsertCollection.upsert(
                { uniqueKey: 'key1_soi_isolated' },
                { value: 'AAA' },
                upsertOptions
            );
            console.log("---- DEBUG UPSERT it_set_on_insert: Первая вставка выполнена, result.operation:", insertResult ? insertResult.operation : 'null_result', "docId:", insertResult && insertResult.document ? insertResult.document._id : 'N/A');
            assert.strictEqual(insertResult.operation, 'inserted');
            assert.strictEqual(insertResult.document.initialPoints, 101);
            const insertedDocId = insertResult.document._id;

            console.log("---- DEBUG UPSERT it_set_on_insert: Перед обновлением (key1_soi_isolated)");
            const updateResult = await upsertCollection.upsert(
                { uniqueKey: 'key1_soi_isolated' },
                { value: 'BBB' },
                upsertOptions
            );
            console.log("---- DEBUG UPSERT it_set_on_insert: Обновление выполнено, result.operation:", updateResult ? updateResult.operation : 'null_result', "docId:", updateResult && updateResult.document ? updateResult.document._id : 'N/A');
            assert.strictEqual(updateResult.operation, 'updated');
            assert.strictEqual(updateResult.document._id, insertedDocId);
            assert.strictEqual(updateResult.document.value, 'BBB');
            assert.strictEqual(updateResult.document.initialPoints, 101, 'setOnInsert поле не должно меняться при update');
            console.log("---- DEBUG UPSERT it_set_on_insert: Завершение");
        });
        console.log("--- DEBUG UPSERT: Завершение блока describe('Метод upsert()') ---");
    });

    // --- Остальные describe блоки закомментированы для изоляции проблемы ---
    /*
    await describe('Гибкая генерация ID (idGenerator)', async () => { ... });
    await describe('Метод count() в Collection', async () => { ... });
    await describe('Хуки/События в Collection', async () => { ... });
    await describe('Сегментация файлов', async () => { ... }); // Сегментация может быть затрагивающей
    await describe('Очередь операций записи (Write Queue)', async () => { ... });
    await describe('Обработка ошибок и граничные случаи', async () => { ... });
    */

    // --- Вывод итогов ---
    console.log('\n\n--- Итоги Расширенных Тестов ---');
    console.log(`Всего тестов запущено: ${totalTests}`);
    console.log(`✅ Пройдено: ${passedTests}`);
    console.log(`❌ Провалено: ${failedTests}`);

    if (failedTests > 0) {
        console.error('\n🔥🔥🔥 ЕСТЬ ПРОВАЛЕННЫЕ ТЕСТЫ! 🔥🔥🔥');
        failedTestDetails.forEach(fail => {
            console.error(`\n  Описание: ${fail.description}`);
            console.error(`  Ошибка: ${fail.error}`);
            if (fail.stack) {
                // console.error(`  Стек:\n${fail.stack}`);
            }
        });
    } else if (totalTests > 0) { // Выводим успех только если были запущены тесты
        console.log('\n🎉🎉🎉 ВСЕ (ЗАПУЩЕННЫЕ) РАСШИРЕННЫЕ ТЕСТЫ ПРОЙДЕНЫ УСПЕШНО! 🎉🎉🎉');
    } else {
        console.warn("\n⚠️ Не было запущено ни одного основного теста (кроме инициализации).");
    }
}

// Запуск расширенных тестов
runAdvancedTests().catch(err => {
    console.error("КРИТИЧЕСКАЯ ОШИБКА ВНЕ ТЕСТОВОГО СЦЕНАРИЯ:", err);
    failedTests++; 
}).finally(() => {
    if (totalTests === 0 && passedTests === 0 && failedTests === 0 && !db) { // Проверка, что db не был создан
        console.error("Тесты не были запущены из-за критической ошибки на самом раннем этапе (до инициализации DB).");
    }
});