// test/full-test-wise-json.js
const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const WiseJSON = require('../wise-json/index.js');
const StorageUtils = require('../wise-json/storage-utils.js'); 

const TEST_DB_ROOT_DIR = path.resolve(__dirname, 'test_db_data_full');
const ITEMS_COLLECTION_NAME = 'testItems';
const USERS_COLLECTION_NAME = 'users';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function setupTestDirectory() {
    try {
        await fs.rm(TEST_DB_ROOT_DIR, { recursive: true, force: true });
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(TEST_DB_ROOT_DIR, { recursive: true });
}

async function cleanupTestDirectory() {
    try {
        await fs.rm(TEST_DB_ROOT_DIR, { recursive: true, force: true });
    } catch (error) {
        console.warn("Предупреждение: Ошибка при удалении тестовой директории:", error.message);
    }
}

async function runTests() {
    let db;
    let itemsCollection;
    let usersCollection;
    let testRunSuccess = true; 

    console.log("Запуск интенсивных тестов WiseJSON (с индексами)...");

    try {
        // --- Тест 1: Базовая инициализация и CRUD (без явных индексов) ---
        console.log("\n--- Группа тестов 1: Базовая инициализация и CRUD ---");
        await setupTestDirectory();
        db = new WiseJSON(TEST_DB_ROOT_DIR, {
            checkpointIntervalMs: 300, 
            maxWalEntriesBeforeCheckpoint: 3, 
            walForceSync: false, 
            checkpointsToKeep: 2,
        });
        await db.baseDirInitPromise; 

        itemsCollection = await db.collection(ITEMS_COLLECTION_NAME);
        assert.ok(itemsCollection, `Коллекция '${ITEMS_COLLECTION_NAME}' должна быть создана`);
        console.log(`Коллекция '${ITEMS_COLLECTION_NAME}' создана, начинаем CRUD.`);

        let item1 = await itemsCollection.insert({ name: 'Тестовый элемент 1', value: 100, type: 'A' });
        assert.strictEqual(item1.name, 'Тестовый элемент 1');
        assert.ok(item1._id && item1.createdAt && item1.updatedAt, "item1 должен иметь системные поля");
        console.log("item1 вставлен.");

        let item2 = await itemsCollection.insert({ name: 'Тестовый элемент 2', value: 200, tags: ['a', 'b'], type: 'B' });
        console.log("item2 вставлен.");
        
        let retrievedItem1 = await itemsCollection.getById(item1._id);
        assert.deepStrictEqual(retrievedItem1, item1);
        console.log("getById item1 прошел.");

        let count = await itemsCollection.count();
        assert.strictEqual(count, 2);
        console.log("count после 2 вставок прошел.");

        let allItems = await itemsCollection.getAll();
        assert.strictEqual(allItems.length, 2);
        console.log("getAll после 2 вставок прошел.");

        let foundItem2 = await itemsCollection.findOne(doc => doc.value === 200);
        assert.deepStrictEqual(foundItem2, item2);
        console.log("findOne item2 прошел.");

        let itemsWithValueGt150 = await itemsCollection.find(doc => doc.value > 150);
        assert.strictEqual(itemsWithValueGt150.length, 1);
        assert.deepStrictEqual(itemsWithValueGt150[0], item2);
        console.log("find item2 прошел.");

        const updates = { value: 250, newField: 'test' };
        let updatedItem2 = await itemsCollection.update(item2._id, updates);
        assert.ok(updatedItem2);
        assert.strictEqual(updatedItem2.value, 250);
        assert.notStrictEqual(updatedItem2.updatedAt, item2.updatedAt);
        console.log("update item2 прошел.");
        item2 = updatedItem2; 
        
        let finalItem2 = await itemsCollection.getById(item2._id);
        assert.strictEqual(finalItem2.value, 250);

        let removed = await itemsCollection.remove(item1._id);
        assert.strictEqual(removed, true, "remove существующего элемента должен вернуть true");
        count = await itemsCollection.count();
        assert.strictEqual(count, 1);
        let nonExistentItem1 = await itemsCollection.getById(item1._id);
        assert.strictEqual(nonExistentItem1, null);
        console.log("remove item1 прошел.");

        removed = await itemsCollection.remove('несуществующий-id-12345');
        assert.strictEqual(removed, false, "remove несуществующего элемента должен вернуть false");
        count = await itemsCollection.count(); 
        assert.strictEqual(count, 1);
        console.log("remove несуществующего прошел.");

        const upsertDataNew = { email: 'new@example.com', name: 'Новый пользователь Upsert', type: 'A' };
        let upsertResultNew = await itemsCollection.upsert({ email: 'new@example.com' }, upsertDataNew);
        assert.strictEqual(upsertResultNew.operation, 'inserted');
        count = await itemsCollection.count();
        assert.strictEqual(count, 2);
        console.log("upsert (insert) прошел.");

        const upsertDataUpdate = { name: 'Обновленный пользователь Upsert', city: 'Город Y' };
        let upsertResultUpdate = await itemsCollection.upsert({ email: 'new@example.com' }, upsertDataUpdate);
        assert.strictEqual(upsertResultUpdate.operation, 'updated');
        count = await itemsCollection.count();
        assert.strictEqual(count, 2);
        console.log("upsert (update) прошел.");
        
        await itemsCollection.clear();
        count = await itemsCollection.count();
        assert.strictEqual(count, 0);
        console.log("clear прошел.");

        console.log("Группа тестов 1: УСПЕШНО");

        // --- Тест 2: Персистентность и перестроение индексов ---
        console.log("\n--- Группа тестов 2: Персистентность и перестроение индексов ---");
        usersCollection = await db.collection(USERS_COLLECTION_NAME, { checkpointsToKeep: 1 }); 
        
        await usersCollection.createIndex('email', { unique: true });
        await usersCollection.createIndex('city'); 
        console.log("Индексы для 'usersCollection' созданы ('email' unique, 'city' simple).");

        const userAliceData = { name: 'Alice', email: 'alice@example.com', city: 'New York', age: 30 };
        const userBobData = { name: 'Bob', email: 'bob@example.com', city: 'London', age: 24 };
        const userCharlieData = { name: 'Charlie', email: 'charlie@example.com', city: 'New York', age: 35 };

        const userAlice = await usersCollection.insert(userAliceData);
        const userBob = await usersCollection.insert(userBobData);
        const userCharlie = await usersCollection.insert(userCharlieData);
        
        await usersCollection.save(); 
        console.log("Данные 'usersCollection' с индексами сохранены.");
        let statsBeforeClose = await usersCollection.getCollectionStats();
        assert.strictEqual(statsBeforeClose.indexes.length, 2, "Должно быть 2 определения индекса перед закрытием");
        assert.strictEqual(statsBeforeClose.indexes.find(i=>i.fieldName==='email').entries, 3, "Индекс email должен иметь 3 записи");
        assert.strictEqual(statsBeforeClose.indexes.find(i=>i.fieldName==='city').entries, 2, "Индекс city должен иметь 2 записи (NY, London)");

        await db.close();
        console.log("База данных закрыта (Тест 2)");

        db = new WiseJSON(TEST_DB_ROOT_DIR, { checkpointIntervalMs: 0, maxWalEntriesBeforeCheckpoint: 0 }); 
        await db.baseDirInitPromise;
        usersCollection = await db.collection(USERS_COLLECTION_NAME);
        console.log("База данных и 'usersCollection' открыты снова.");
        
        count = await usersCollection.count();
        assert.strictEqual(count, 3, "Количество пользователей после перезагрузки должно быть 3");

        let statsAfterReopen = await usersCollection.getCollectionStats();
        assert.strictEqual(statsAfterReopen.indexes.length, 2, "Определения индексов должны были восстановиться");
        let emailIndexInfo = statsAfterReopen.indexes.find(idx => idx.fieldName === 'email');
        let cityIndexInfo = statsAfterReopen.indexes.find(idx => idx.fieldName === 'city');
        assert.ok(emailIndexInfo && emailIndexInfo.type === 'unique', "Уникальный индекс 'email' восстановлен");
        assert.ok(cityIndexInfo && cityIndexInfo.type === 'simple', "Простой индекс 'city' восстановлен");
        assert.strictEqual(emailIndexInfo.entries, 3, "Уникальный индекс 'email' должен содержать 3 записи после перестроения");
        assert.strictEqual(cityIndexInfo.entries, 2, "Простой индекс 'city' должен содержать 2 записи после перестроения");

        let reloadedAlice = await usersCollection.findOneByIndexedValue('email', 'alice@example.com');
        assert.ok(reloadedAlice, "Alice должна найтись по уникальному email индексу");
        if(reloadedAlice) assert.strictEqual(reloadedAlice.name, 'Alice');

        let usersInNewYork = await usersCollection.findByIndexedValue('city', 'New York');
        assert.strictEqual(usersInNewYork.length, 2, "Должно быть 2 пользователя в New York по индексу");
        console.log("Персистентность и перестроение индексов проверены.");

        console.log("Группа тестов 2: УСПЕШНО");

        // --- Тест 3: Работа WAL с индексами ---
        console.log("\n--- Группа тестов 3: Работа WAL с индексами ---");
        const userDavidData = {name: 'David', email: 'david@example.com', city: 'Paris', age: 28};
        const userDavid = await usersCollection.insert(userDavidData); 
        console.log("David вставлен (операция должна обновить индексы и пойти в WAL).");
        
        statsAfterReopen = await usersCollection.getCollectionStats(); // Получаем актуальные статы
        emailIndexInfo = statsAfterReopen.indexes.find(idx => idx.fieldName === 'email');
        cityIndexInfo = statsAfterReopen.indexes.find(idx => idx.fieldName === 'city');
        assert.strictEqual(emailIndexInfo.entries, 4, "Индекс email должен иметь 4 записи после вставки David");
        assert.strictEqual(cityIndexInfo.entries, 3, "Индекс city должен иметь 3 записи (NY, London, Paris)");
        
        // "Сбой"
        db = new WiseJSON(TEST_DB_ROOT_DIR);
        await db.baseDirInitPromise;
        usersCollection = await db.collection(USERS_COLLECTION_NAME);
        console.log("БД 'перезапущена' для теста WAL с индексами.");

        count = await usersCollection.count();
        assert.strictEqual(count, 4, "Количество пользователей после 'сбоя' и WAL должно быть 4");
        
        statsAfterReopen = await usersCollection.getCollectionStats(); // Снова после перезапуска
        emailIndexInfo = statsAfterReopen.indexes.find(idx => idx.fieldName === 'email');
        cityIndexInfo = statsAfterReopen.indexes.find(idx => idx.fieldName === 'city');
        assert.ok(emailIndexInfo && emailIndexInfo.type === 'unique' && emailIndexInfo.entries === 4, "Уник. индекс 'email' корректно перестроен (4) после WAL");
        assert.ok(cityIndexInfo && cityIndexInfo.type === 'simple' && cityIndexInfo.entries === 3, "Простой индекс 'city' корректно перестроен (3) после WAL");

        const reloadedDavid = await usersCollection.findOneByIndexedValue('email', 'david@example.com');
        assert.ok(reloadedDavid && reloadedDavid.name === 'David', "David (из WAL) должен восстановиться и быть в индексе");
        console.log("Восстановление из WAL с перестроением индексов проверено.");

        console.log("Группа тестов 3: УСПЕШНО");

        // --- Тест 4: Автоматическое обновление индексов при CRUD ---
        console.log("\n--- Группа тестов 4: Автоматическое обновление индексов при CRUD ---");
        // Очищаем и пересоздаем индексы для чистоты этого теста
        await usersCollection.clear();
        await usersCollection.dropIndex('email').catch(()=>{}); // Игнорируем ошибку, если индекса нет
        await usersCollection.dropIndex('city').catch(()=>{});
        await usersCollection.createIndex('email', {unique: true});
        await usersCollection.createIndex('city');

        let alice = await usersCollection.insert({ _id: 'alice1', name: 'Alice', email: 'alice@example.com', city: 'New York', age: 30 });
        let bob = await usersCollection.insert({ _id: 'bob1', name: 'Bob', email: 'bob@example.com', city: 'London', age: 24 });
        let charlie = await usersCollection.insert({ _id: 'charlie1', name: 'Charlie', email: 'charlie@example.com', city: 'New York', age: 35 });

        const updatedAlice = await usersCollection.update(alice._id, { city: 'Paris', email: 'alice_new@example.com' });
        assert.ok(updatedAlice && updatedAlice.city === 'Paris' && updatedAlice.email === 'alice_new@example.com');

        let aliceByOldEmail = await usersCollection.findOneByIndexedValue('email', 'alice@example.com');
        assert.strictEqual(aliceByOldEmail, null);
        let aliceByNewEmail = await usersCollection.findOneByIndexedValue('email', 'alice_new@example.com');
        assert.ok(aliceByNewEmail && aliceByNewEmail._id === alice._id);

        let usersInNY = await usersCollection.findByIndexedValue('city', 'New York');
        assert.strictEqual(usersInNY.length, 1); 
        let usersInParis = await usersCollection.findByIndexedValue('city', 'Paris');
        assert.strictEqual(usersInParis.length, 1);
        console.log("Обновление индекса после UPDATE проверено.");

        await usersCollection.remove(bob._id); 
        
        let bobByEmail = await usersCollection.findOneByIndexedValue('email', 'bob@example.com');
        assert.strictEqual(bobByEmail, null);
        let usersInLondon = await usersCollection.findByIndexedValue('city', 'London');
        assert.strictEqual(usersInLondon.length, 0);
        console.log("Обновление индекса после REMOVE проверено.");

        await usersCollection.clear();
        statsAfterReopen = await usersCollection.getCollectionStats();
        emailIndexInfo = statsAfterReopen.indexes.find(idx => idx.fieldName === 'email');
        cityIndexInfo = statsAfterReopen.indexes.find(idx => idx.fieldName === 'city');
        assert.ok(emailIndexInfo && emailIndexInfo.entries === 0, "Индекс email должен быть пуст после clear");
        assert.ok(cityIndexInfo && cityIndexInfo.entries === 0, "Индекс city должен быть пуст после clear");
        console.log("Обновление индекса после CLEAR проверено.");
        
        console.log("Группа тестов 4: УСПЕШНО");

        // --- Тест 5: Уникальные индексы - проверки нарушений ---
        console.log("\n--- Группа тестов 5: Уникальные индексы - проверки нарушений ---");
        // usersCollection пуста, индексы 'email' (unique) и 'city' (simple) существуют
        let eve = await usersCollection.insert({ name: 'Eve', email: 'eve@example.com', city: 'Berlin' });
        
        let uniqueErrorCaught = false;
        try { await usersCollection.insert({ name: 'Eve Twin', email: 'eve@example.com', city: 'Munich' });
        } catch (e) { assert.ok(e.message.includes("Нарушение уникального индекса") && e.message.includes("'email'")); uniqueErrorCaught = true; }
        assert.ok(uniqueErrorCaught, "Ошибка уник. индекса при insert");
        count = await usersCollection.count(); assert.strictEqual(count, 1);
        console.log("Проверка уник. при INSERT прошла.");

        let frank = await usersCollection.insert({ name: 'Frank', email: 'frank@example.com', city: 'Hamburg' });
        uniqueErrorCaught = false;
        try { await usersCollection.update(frank._id, { email: 'eve@example.com' }); 
        } catch (e) { assert.ok(e.message.includes("Нарушение уник. индекса") && e.message.includes("'email'")); uniqueErrorCaught = true; }
        assert.ok(uniqueErrorCaught, "Ошибка уник. индекса при update");
        const reloadedFrank = await usersCollection.getById(frank._id);
        assert.strictEqual(reloadedFrank.email, 'frank@example.com');
        console.log("Проверка уник. при UPDATE прошла.");

        uniqueErrorCaught = false;
        try { await usersCollection.upsert({ email: 'frank@example.com' }, { email: 'eve@example.com' });
        } catch (e) { 
            assert.ok(e.message.includes("Upsert (update path) нарушает уникальный индекс") && e.message.includes("'email'"), `Неверное сообщение об ошибке: ${e.message}`); 
            uniqueErrorCaught = true; 
        }
        assert.ok(uniqueErrorCaught, "Ошибка уник. индекса при upsert (update path)");
        console.log("Проверка уник. при UPSERT (update path) прошла.");
        
        uniqueErrorCaught = false;
        try { await usersCollection.upsert({ email: 'new_user_dup@example.com' }, { email: 'eve@example.com', name: 'New User Dup' });
        } catch (e) { 
            assert.ok(e.message.includes("Upsert (insert path) нарушает уникальный индекс") && e.message.includes("'email'"), `Неверное сообщение об ошибке: ${e.message}`);
            uniqueErrorCaught = true; 
        }
        assert.ok(uniqueErrorCaught, "Ошибка уник. индекса при upsert (insert path)");
        count = await usersCollection.count(); assert.strictEqual(count, 2);
        console.log("Проверка уник. при UPSERT (insert path) прошла.");

        await usersCollection.insert({ name: 'User A', nonUniqueField: 'sharedVal' });
        await usersCollection.insert({ name: 'User B', nonUniqueField: 'sharedVal' });
        uniqueErrorCaught = false;
        try { await usersCollection.createIndex('nonUniqueField', { unique: true });
        } catch (e) { assert.ok(e.message.includes("данные содержат дубль") && e.message.includes("'nonUniqueField'")); uniqueErrorCaught = true;}
        assert.ok(uniqueErrorCaught, "Создание уник. индекса на не-уникальных данных должно провалиться");
        let indexes = await usersCollection.getIndexes();
        let nonUniqueIndexInfo = indexes.find(idx => idx.fieldName === 'nonUniqueField');
        assert.ok(!nonUniqueIndexInfo, "Индекс 'nonUniqueField' не должен был быть создан");
        console.log("Проверка создания уник. индекса на не-уникальных данных прошла.");
        
        console.log("Группа тестов 5: УСПЕШНО");

        // --- Тест 6: dropIndex и getIndexes ---
        console.log("\n--- Группа тестов 6: dropIndex и getIndexes ---");
        let currentIndexes = await usersCollection.getIndexes();
        assert.ok(currentIndexes.some(idx => idx.fieldName === 'email') && currentIndexes.some(idx => idx.fieldName === 'city'), "Должны существовать индексы 'email' и 'city'");
        
        let dropped = await usersCollection.dropIndex('city');
        assert.strictEqual(dropped, true);
        currentIndexes = await usersCollection.getIndexes();
        assert.strictEqual(currentIndexes.length, 1, "Должен остаться 1 индекс (email) после удаления 'city'");
        if(currentIndexes.length === 1) assert.strictEqual(currentIndexes[0].fieldName, 'email');

        dropped = await usersCollection.dropIndex('nonExistentField');
        assert.strictEqual(dropped, false);
        currentIndexes = await usersCollection.getIndexes();
        assert.strictEqual(currentIndexes.length, 1);
        
        await usersCollection.dropIndex('email');
        currentIndexes = await usersCollection.getIndexes();
        assert.strictEqual(currentIndexes.length, 0, "Все индексы должны быть удалены");
        console.log("dropIndex и getIndexes проверены.");

        console.log("Проверка поиска по удаленному индексу (ожидаются предупреждения)...");
        const citySearchAfterDrop = await usersCollection.findByIndexedValue('city', 'Berlin'); 
        assert.strictEqual(citySearchAfterDrop.length, 0);
        
        console.log("Группа тестов 6: УСПЕШНО");

        // --- Тест 7: Стабильность чекпоинтов (ранее Тест 5) ---
        console.log("\n--- Группа тестов 7: Стабильность чекпоинтов ---");
        await db.close();
        db = new WiseJSON(TEST_DB_ROOT_DIR, { 
            checkpointIntervalMs: 200, maxWalEntriesBeforeCheckpoint: 4, 
            checkpointsToKeep: 2, walForceSync: false 
        });
        await db.baseDirInitPromise;
        itemsCollection = await db.collection(ITEMS_COLLECTION_NAME); 
        await itemsCollection.clear(); 

        const currentMaxWalEntries = itemsCollection.options.maxWalEntriesBeforeCheckpoint; 
        const numSmallDocs = currentMaxWalEntries * 2 + 1; 
        const smallDocPromises = [];
        console.log(`(Тест 7) Вставка ${numSmallDocs} мелких документов (лимит WAL: ${currentMaxWalEntries})...`);
        for(let i=0; i<numSmallDocs; ++i) smallDocPromises.push(itemsCollection.insert({ tiny: i, testRun: 7 }));
        await Promise.all(smallDocPromises);
        count = await itemsCollection.count(); assert.strictEqual(count, numSmallDocs);
        
        const delayForCheckpoints = Math.max(1000, (itemsCollection.options.checkpointIntervalMs || 0) * 3);
        console.log(`(Тест 7) Ожидание срабатывания чекпоинтов (около ${delayForCheckpoints} мс)...`);
        await delay(delayForCheckpoints); 

        const statsAfterManyInserts = await itemsCollection.getCollectionStats();
        assert.ok(statsAfterManyInserts.walEntriesSinceLastCheckpoint < currentMaxWalEntries || currentMaxWalEntries === 0, 
            `(Тест 7) WAL сброшен (осталось: ${statsAfterManyInserts.walEntriesSinceLastCheckpoint}, лимит: ${currentMaxWalEntries})`);
        
        console.log("(Тест 7) Создание нескольких чекпоинтов для проверки очистки...");
        const numSeriesForCleanup = itemsCollection.options.maxWalEntriesBeforeCheckpoint * (itemsCollection.options.checkpointsToKeep + 2);
        for (let i=0; i < numSeriesForCleanup ; ++i) {
             await itemsCollection.insert({ seriesForCleanup: i, testRun: 7 });
             if ((i + 1) % currentMaxWalEntries === 0) await delay(50);
        }
        await itemsCollection.save(); 
        
        await delay(Math.max(500, (itemsCollection.options.checkpointIntervalMs || 0) + 200)); 
        
        const checkpointsDir = itemsCollection.checkpointsDirPath;
        try {
            if (await StorageUtils.pathExists(checkpointsDir)) {
                const checkpointFilesAfterDelay = await fs.readdir(checkpointsDir);
                const metaFilesAfterDelay = checkpointFilesAfterDelay.filter(f => f.startsWith('checkpoint_meta_') && f.includes(ITEMS_COLLECTION_NAME) && f.endsWith('.json'));
                assert.ok(metaFilesAfterDelay.length <= itemsCollection.options.checkpointsToKeep,
                    `(Тест 7) Мета-файлов чекпоинтов: ${metaFilesAfterDelay.length}, ожидалось <= ${itemsCollection.options.checkpointsToKeep}.`);
            } else { console.warn(`(Тест 7) Директория чекпоинтов ${checkpointsDir} не найдена.`); }
        } catch (e) { if (e.code !== 'ENOENT') throw e; console.warn("(Тест 7) Директория чекпоинтов не найдена.") }
        console.log("Группа тестов 7: УСПЕШНО");

        // --- Тест 8: Закрытие БД (ранее Тест 6) ---
        console.log("\n--- Группа тестов 8: Закрытие БД ---");
        await itemsCollection.insert({ name: "Данные перед закрытием items", finalTestMarker: true });
        const countBeforeCloseItems = await itemsCollection.count();
        console.log(`Документов в itemsCollection перед закрытием: ${countBeforeCloseItems}`);
        
        const itemsCollectionRef = itemsCollection; 
        const initPromiseBeforeCloseItems = itemsCollectionRef.initPromise;

        await db.close(); 
        console.log("База данных и все коллекции закрыты.");

        console.log("Тест: Проверка состояния itemsCollectionRef.initPromise после db.close().");
        let promiseStateCheckErrorItems = null;
        try {
            if (itemsCollectionRef && itemsCollectionRef.initPromise) {
                 assert.notStrictEqual(itemsCollectionRef.initPromise, initPromiseBeforeCloseItems, "initPromise должен измениться");
                 await itemsCollectionRef.initPromise; 
            } else { assert.fail("itemsCollectionRef или initPromise отсутствует."); }
        } catch (e) {
            promiseStateCheckErrorItems = e;
            assert.ok(e.message.includes("is closed"), `Ошибка initPromise ("${e.message}") должна содержать 'is closed'.`);
        }
        assert.ok(promiseStateCheckErrorItems, "initPromise itemsCollection должен быть отклонен.");

        let erroredItems = false;
        try {
            console.log("Тест: Попытка itemsCollectionRef.insert() после закрытия...");
            await itemsCollectionRef.insert({ name: "Попытка записи в itemsCollection после закрытия" });
        } catch (e) {
            console.log(`Тест: itemsCollectionRef.insert() ошибка: "${e.message}" (ожидаемо).`);
            assert.ok(e.message.includes("is closed") || e.message.includes("не инициализирована"), `Ожидалась ошибка, получено: "${e.message}"`);
            erroredItems = true;
        }
        assert.ok(erroredItems, "Операция на закрытом itemsCollectionRef должна вызвать ошибку");
        console.log("Проверка операции на закрытой itemsCollection пройдена.");

        db = new WiseJSON(TEST_DB_ROOT_DIR); 
        await db.baseDirInitPromise;
        itemsCollection = await db.collection(ITEMS_COLLECTION_NAME); 
        const countAfterReopenItems = await itemsCollection.count();
        assert.strictEqual(countAfterReopenItems, countBeforeCloseItems, 
            `Кол-во док-ов в itemsCollection. Ожидалось: ${countBeforeCloseItems}, Получено: ${countAfterReopenItems}`);
        
        const lastItemInItems = await itemsCollection.findOne(doc => doc.finalTestMarker === true);
        assert.ok(lastItemInItems);
        if(lastItemInItems) assert.strictEqual(lastItemInItems.name, "Данные перед закрытием items");
        console.log("Проверка данных itemsCollection после повторного открытия БД пройдена.");

        console.log("Группа тестов 8: УСПЕШНО");

    } catch (error) {
        console.error("\n🔥🔥🔥 ПРОИЗОШЛА КРИТИЧЕСКАЯ ОШИБКА В ТЕСТЕ: 🔥🔥🔥");
        console.error(error);
        testRunSuccess = false; 
    } finally {
        console.log("\nЗавершение тестов, очистка...");
        if (db && typeof db.close === 'function') {
            let canCloseDb = false;
            if (db.baseDirInitPromise) {
                try { await db.baseDirInitPromise.catch(() => {}); canCloseDb = true; } catch(e) {}
            }
            if (canCloseDb && ((db.collectionsCache && db.collectionsCache.size > 0) || (db.initializingCollections && db.initializingCollections.size > 0))) {
                 console.log("Очистка: Попытка закрыть БД в finally...");
                 await db.close().catch(e => console.error("Очистка: Ошибка при закрытии БД в finally:", e.message));
                 console.log("Очистка: БД закрыта в finally.");
            } else if (canCloseDb) {
                 console.log("Очистка: БД уже была закрыта или нечего закрывать.");
            } else {
                console.log("Очистка: Инициализация БД не была завершена, пропуск закрытия.");
            }
        }
        await cleanupTestDirectory();
        console.log("\nТестирование WiseJSON завершено.");
        if (!testRunSuccess) {
             console.log("🔴 Тесты провалены.");
             process.exitCode = 1; 
        } else {
            console.log("✅ Все тесты успешно пройдены!");
        }
    }
}

runTests();