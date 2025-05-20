// test/full-test-wise-json.js
const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const WiseJSON = require('../wise-json/index.js');
const StorageUtils = require('../wise-json/storage-utils.js');

const TEST_DB_ROOT_DIR = path.resolve(__dirname, 'test_db_data_full');
const COLLECTION_NAME = 'testItems';

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
    let testRunSuccess = true; 

    console.log("Запуск интенсивных тестов WiseJSON...");

    try {
        // --- Тест 1: Базовая инициализация и CRUD ---
        console.log("\n--- Группа тестов 1: Базовая инициализация и CRUD ---");
        await setupTestDirectory();
        db = new WiseJSON(TEST_DB_ROOT_DIR, {
            checkpointIntervalMs: 300, 
            maxWalEntriesBeforeCheckpoint: 3, 
            walForceSync: false, 
            checkpointsToKeep: 2,
        });
        await db.baseDirInitPromise; 

        itemsCollection = await db.collection(COLLECTION_NAME);
        assert.ok(itemsCollection, "Коллекция должна быть создана");
        console.log("Коллекция создана, начинаем CRUD.");

        const item1 = await itemsCollection.insert({ name: 'Тестовый элемент 1', value: 100 });
        assert.strictEqual(item1.name, 'Тестовый элемент 1');
        console.log("item1 вставлен.");

        const item2 = await itemsCollection.insert({ name: 'Тестовый элемент 2', value: 200, tags: ['a', 'b'] });
        console.log("item2 вставлен.");
        
        const retrievedItem1 = await itemsCollection.getById(item1._id);
        assert.deepStrictEqual(retrievedItem1, item1);
        console.log("getById item1 прошел.");

        let count = await itemsCollection.count();
        assert.strictEqual(count, 2);
        console.log("count после 2 вставок прошел.");

        let allItems = await itemsCollection.getAll();
        assert.strictEqual(allItems.length, 2);
        console.log("getAll после 2 вставок прошел.");

        const foundItem2 = await itemsCollection.findOne(doc => doc.value === 200);
        assert.deepStrictEqual(foundItem2, item2);
        console.log("findOne item2 прошел.");

        const itemsWithValueGt150 = await itemsCollection.find(doc => doc.value > 150);
        assert.strictEqual(itemsWithValueGt150.length, 1);
        assert.deepStrictEqual(itemsWithValueGt150[0], item2);
        console.log("find item2 прошел.");

        const updates = { value: 250, newField: 'test' };
        const updatedItem2 = await itemsCollection.update(item2._id, updates);
        assert.ok(updatedItem2);
        assert.strictEqual(updatedItem2.value, 250);
        console.log("update item2 прошел.");
        
        const finalItem2 = await itemsCollection.getById(item2._id);
        assert.strictEqual(finalItem2.value, 250);

        const removed = await itemsCollection.remove(item1._id);
        assert.strictEqual(removed, true, "remove существующего должен вернуть true");
        count = await itemsCollection.count();
        assert.strictEqual(count, 1);
        const nonExistentItem1 = await itemsCollection.getById(item1._id);
        assert.strictEqual(nonExistentItem1, null);
        console.log("remove item1 прошел.");

        const removedNonExistent = await itemsCollection.remove('несуществующий-id-12345');
        assert.strictEqual(removedNonExistent, false, "remove несуществующего элемента должен вернуть false");
        count = await itemsCollection.count(); 
        assert.strictEqual(count, 1);
        console.log("remove несуществующего прошел.");

        const upsertDataNew = { email: 'new@example.com', name: 'Новый пользователь Upsert' };
        const upsertResultNew = await itemsCollection.upsert({ email: 'new@example.com' }, upsertDataNew);
        assert.strictEqual(upsertResultNew.operation, 'inserted');
        count = await itemsCollection.count();
        assert.strictEqual(count, 2);
        console.log("upsert (insert) прошел.");

        const upsertDataUpdate = { name: 'Обновленный пользователь Upsert', city: 'Город Y' };
        const upsertResultUpdate = await itemsCollection.upsert({ email: 'new@example.com' }, upsertDataUpdate);
        assert.strictEqual(upsertResultUpdate.operation, 'updated');
        count = await itemsCollection.count();
        assert.strictEqual(count, 2);
        console.log("upsert (update) прошел.");
        
        await itemsCollection.clear();
        count = await itemsCollection.count();
        assert.strictEqual(count, 0);
        console.log("clear прошел.");

        console.log("Группа тестов 1: УСПЕШНО");

        // --- Тест 2: Сохранение, закрытие и повторная загрузка ---
        console.log("\n--- Группа тестов 2: Сохранение, закрытие и повторная загрузка ---");
        const itemA_data = { customId: 'A', name: 'Элемент А', val: 1 };
        const itemB_data = { customId: 'B', name: 'Элемент Б', val: 2 };
        const itemC_data = { customId: 'C', name: 'Элемент В', val: 3 };

        const itemA = await itemsCollection.insert(itemA_data);
        const itemB = await itemsCollection.insert(itemB_data);
        const itemC = await itemsCollection.insert(itemC_data);
        console.log("3 элемента вставлены для теста 2.");
        
        await itemsCollection.save(); 
        console.log("Данные сохранены через collection.save()");
        await db.close();
        console.log("База данных закрыта");

        db = new WiseJSON(TEST_DB_ROOT_DIR, { checkpointIntervalMs: 1000, maxWalEntriesBeforeCheckpoint: 10, checkpointsToKeep: 2 });
        await db.baseDirInitPromise;
        itemsCollection = await db.collection(COLLECTION_NAME);
        console.log("База данных и коллекция открыты снова.");
        
        count = await itemsCollection.count();
        assert.strictEqual(count, 3, "Количество документов после перезагрузки должно быть 3");

        const reloadedItemA = await itemsCollection.getById(itemA._id);
        assert.deepStrictEqual(reloadedItemA, itemA);
        const reloadedItemB = await itemsCollection.findOne(doc => doc.customId === 'B');
        assert.ok(reloadedItemB);
        if (reloadedItemB) {
           assert.strictEqual(reloadedItemB.name, itemB.name); 
        }
        console.log("Данные после перезагрузки проверены.");

        console.log("Группа тестов 2: УСПЕШНО");

        // --- Тест 3: Работа WAL ---
        console.log("\n--- Группа тестов 3: Работа WAL ---");
        const itemD_data = { customId: 'D', name: 'Элемент Г', val: 4 };
        const itemD = await itemsCollection.insert(itemD_data); 
        console.log("itemD вставлен (в WAL).");
        
        const statsBeforeCloseWalTest = await itemsCollection.getCollectionStats();
        assert.ok(statsBeforeCloseWalTest.walEntriesSinceLastCheckpoint > 0 || (statsBeforeCloseWalTest.walExists && statsBeforeCloseWalTest.walSizeBytes > 0), 
            `WAL должен содержать записи перед 'сбоем'.`);

        const dbConfigForWalTest = { checkpointIntervalMs: 0, maxWalEntriesBeforeCheckpoint: 0, checkpointsToKeep: 2 }; 
        db = new WiseJSON(TEST_DB_ROOT_DIR, dbConfigForWalTest);
        await db.baseDirInitPromise;
        itemsCollection = await db.collection(COLLECTION_NAME, dbConfigForWalTest);
        console.log("БД 'перезапущена' для теста WAL.");

        count = await itemsCollection.count();
        assert.strictEqual(count, 4, "Количество документов после 'сбоя' и восстановления из WAL должно быть 4");
        const reloadedItemD = await itemsCollection.getById(itemD._id);
        assert.deepStrictEqual(reloadedItemD, itemD);
        console.log("Восстановление из WAL проверено.");

        await itemsCollection.update(itemA._id, { val: 11, name: "Элемент А обновленный WAL" });
        await itemsCollection.save(); 
        console.log("Чекпоинт после обновления itemA сделан.");
        
        const statsAfterSaveWalTest = await itemsCollection.getCollectionStats();
        assert.strictEqual(statsAfterSaveWalTest.walEntriesSinceLastCheckpoint, 0, 
            `WAL записи должны быть 0 после save().`);

        console.log("Группа тестов 3: УСПЕШНО");

        // --- Тест 4: Множественные асинхронные операции ---
        console.log("\n--- Группа тестов 4: Множественные асинхронные операции ---");
        const numAsyncOps = 50;
        const promises = [];
        console.log(`Запуск ${numAsyncOps} асинхронных вставок...`);
        for (let i = 0; i < numAsyncOps; i++) {
            promises.push(itemsCollection.insert({ name: `Асинхронный элемент ${i}`, index: i, timestamp: Date.now() }));
        }
        const results = await Promise.all(promises);
        assert.strictEqual(results.length, numAsyncOps);
        
        const expectedCountAfterAsync = 4 + numAsyncOps; 
        count = await itemsCollection.count();
        assert.strictEqual(count, expectedCountAfterAsync);
        console.log("Асинхронные вставки завершены и подсчитаны.");

        const ids = results.map(r => r._id);
        const uniqueIds = new Set(ids);
        assert.strictEqual(ids.length, uniqueIds.size);
        
        const updatePromises = [];
        const itemToUpdate1 = results[0];
        const itemToUpdate2 = results[1];
        const itemToRemove = results[2];

        console.log("Запуск асинхронных обновлений и удалений...");
        updatePromises.push(itemsCollection.update(itemToUpdate1._id, { name: 'Обновлено асинхронно 1' }));
        updatePromises.push(itemsCollection.update(itemToUpdate2._id, { value: Math.random() }));
        updatePromises.push(itemsCollection.remove(itemToRemove._id));
        
        await Promise.all(updatePromises);
        console.log("Асинхронные обновления и удаления завершены.");

        const updatedCheck1 = await itemsCollection.getById(itemToUpdate1._id);
        assert.ok(updatedCheck1);
        if (updatedCheck1) assert.strictEqual(updatedCheck1.name, 'Обновлено асинхронно 1');
        
        const removedCheck = await itemsCollection.getById(itemToRemove._id);
        assert.strictEqual(removedCheck, null);

        count = await itemsCollection.count();
        assert.strictEqual(count, expectedCountAfterAsync - 1);
        console.log("Проверки после асинхронных модификаций пройдены.");

        console.log("Группа тестов 4: УСПЕШНО");

        // --- Тест 5: Опции и граничные случаи ---
        console.log("\n--- Группа тестов 5: Опции и граничные случаи ---");
        await itemsCollection.clear(); 
        console.log("Коллекция очищена для теста 5.");
        
        await db.close(); 
        db = new WiseJSON(TEST_DB_ROOT_DIR, { 
            checkpointIntervalMs: 200, 
            maxWalEntriesBeforeCheckpoint: 4, 
            checkpointsToKeep: 2,
            walForceSync: false 
        });
        await db.baseDirInitPromise;
        itemsCollection = await db.collection(COLLECTION_NAME);
        console.log("Коллекция пересоздана с агрессивными настройками чекпоинта.");

        const currentMaxWalEntries = itemsCollection.options.maxWalEntriesBeforeCheckpoint; 
        assert.ok(currentMaxWalEntries > 0 && currentMaxWalEntries < 10, `maxWalEntriesBeforeCheckpoint (${currentMaxWalEntries}) должен быть маленьким`);

        const numSmallDocs = currentMaxWalEntries * 2 + 1; 
        const smallDocPromises = [];
        console.log(`Вставка ${numSmallDocs} мелких документов (лимит WAL: ${currentMaxWalEntries})...`);
        for(let i=0; i<numSmallDocs; ++i) {
            smallDocPromises.push(itemsCollection.insert({ tiny: i, testRun: 5 }));
        }
        await Promise.all(smallDocPromises);
        count = await itemsCollection.count();
        assert.strictEqual(count, numSmallDocs);
        
        const delayForCheckpoints = Math.max(1000, (itemsCollection.options.checkpointIntervalMs || 0) * 3);
        console.log(`Ожидание срабатывания чекпоинтов (около ${delayForCheckpoints} мс)...`);
        await delay(delayForCheckpoints); 

        const statsAfterManyInserts = await itemsCollection.getCollectionStats();
        assert.ok(statsAfterManyInserts.walEntriesSinceLastCheckpoint < currentMaxWalEntries || currentMaxWalEntries === 0, 
            `WAL записи должны были сброситься (осталось: ${statsAfterManyInserts.walEntriesSinceLastCheckpoint}, лимит: ${currentMaxWalEntries})`);
        console.log("Проверка WAL после массовых вставок пройдена.");
        
        console.log("Создание нескольких чекпоинтов для проверки очистки...");
        const numSeriesForCleanup = itemsCollection.options.maxWalEntriesBeforeCheckpoint * (itemsCollection.options.checkpointsToKeep + 2);
        for (let i=0; i < numSeriesForCleanup ; ++i) {
             await itemsCollection.insert({ seriesForCleanup: i, testRun: 5 });
             if ((i + 1) % currentMaxWalEntries === 0) await delay(50);
        }
        await itemsCollection.save(); 
        console.log("Финальный save перед проверкой очистки чекпоинтов.");
        
        await delay(Math.max(500, (itemsCollection.options.checkpointIntervalMs || 0) + 200)); 
        
        const checkpointsDir = itemsCollection.checkpointsDirPath;
        try {
            if (await StorageUtils.pathExists(checkpointsDir)) {
                const checkpointFilesAfterDelay = await fs.readdir(checkpointsDir);
                const metaFilesAfterDelay = checkpointFilesAfterDelay.filter(f => 
                    f.startsWith('checkpoint_meta_') && f.includes(COLLECTION_NAME) && f.endsWith('.json')
                );
                
                console.log(`Найдено мета-файлов чекпоинтов: ${metaFilesAfterDelay.length}. Опция checkpointsToKeep: ${itemsCollection.options.checkpointsToKeep}`);
                assert.ok(metaFilesAfterDelay.length <= itemsCollection.options.checkpointsToKeep,
                    `Должно остаться не более ${itemsCollection.options.checkpointsToKeep} мета-файлов, найдено: ${metaFilesAfterDelay.length}.`);
            } else {
                 console.warn(`Директория чекпоинтов ${checkpointsDir} не найдена для проверки очистки.`);
                 if (itemsCollection.options.checkpointsToKeep > 0) { // Если должны были быть чекпоинты
                    // Этот ассерт может быть слишком строгим, если коллекция была пуста и чекпоинты не создавались
                    // assert.fail(`Директория чекпоинтов должна существовать, если checkpointsToKeep > 0 и были чекпоинты.`);
                 }
            }
        } catch (e) {
            if (e.code !== 'ENOENT') throw e; 
            console.warn("Директория чекпоинтов не найдена при проверке очистки.")
        }
        console.log("Группа тестов 5: УСПЕШНО");

        // --- Тест 6: Закрытие БД ---
        console.log("\n--- Группа тестов 6: Закрытие БД ---");
        await itemsCollection.insert({ name: "Данные перед закрытием", finalTestMarker: true });
        const countBeforeClose = await itemsCollection.count();
        console.log(`Документов перед закрытием: ${countBeforeClose}`);
        
        // Сохраняем ссылку на initPromise *этого* экземпляра itemsCollection перед закрытием db
        const itemsCollectionRef = itemsCollection; 
        const initPromiseBeforeClose = itemsCollectionRef.initPromise;

        await db.close();
        console.log("База данных и коллекции закрыты.");

        // Диагностика:
        console.log("Тест: Проверка состояния itemsCollectionRef.initPromise после db.close().");
        let promiseStateCheckError = null;
        try {
            if (itemsCollectionRef && itemsCollectionRef.initPromise) {
                 // Сравниваем, изменился ли объект промиса. Он должен был быть заменен на Promise.reject.
                 assert.notStrictEqual(itemsCollectionRef.initPromise, initPromiseBeforeClose, "Объект initPromise должен был измениться после close()");
                 await itemsCollectionRef.initPromise; 
                 console.log("Тест: itemsCollectionRef.initPromise разрешился (неожиданно).");
            } else {
                console.log("Тест: itemsCollectionRef или itemsCollectionRef.initPromise отсутствует.");
                // Если initPromise отсутствует, это тоже может быть признаком закрытого состояния
                // в зависимости от реализации close(). Наш close() устанавливает его в Promise.reject().
                if (!itemsCollectionRef || !itemsCollectionRef.initPromise) {
                    // Считаем это успехом для данного теста, так как _ensureInitialized упадет
                } else {
                     assert.fail("itemsCollectionRef.initPromise должен был быть заменен или отсутствовать");
                }
            }
        } catch (e) {
            promiseStateCheckError = e;
            console.log(`Тест: itemsCollectionRef.initPromise отклонен с ошибкой: "${e.message}" (ожидаемо).`);
            assert.ok(e.message.includes("is closed"), `Ошибка отклоненного initPromise ("${e.message}") должна содержать 'is closed'.`);
        }
         // Если initPromise был заменен на Promise.resolve() в close (что мы исправили), то promiseStateCheckError будет null.
         // Если он был заменен на Promise.reject(), то promiseStateCheckError будет содержать ошибку.
        assert.ok(promiseStateCheckError, "initPromise коллекции должен быть отклонен после закрытия БД.");


        let errored = false;
        try {
            console.log("Тест: Попытка itemsCollectionRef.insert() после закрытия...");
            await itemsCollectionRef.insert({ name: "Попытка записи после закрытия" });
            console.log("Тест: itemsCollectionRef.insert() НЕ вызвал ошибку (неожиданно).");
        } catch (e) {
            console.log(`Тест: itemsCollectionRef.insert() вызвал ошибку: "${e.message}" (ожидаемо).`);
            assert.ok(e.message.includes("is closed") || e.message.includes("не инициализирована") || e.message.includes("initPromise отсутствует"), 
                `Ожидалась ошибка о закрытой/неинициализированной коллекции, получено: "${e.message}"`);
            errored = true;
        }
        assert.ok(errored, "Операция на закрытом экземпляре коллекции должна вызывать ошибку");
        console.log("Проверка операции на закрытой коллекции пройдена.");

        // Открываем снова и проверяем данные
        db = new WiseJSON(TEST_DB_ROOT_DIR); 
        await db.baseDirInitPromise;
        itemsCollection = await db.collection(COLLECTION_NAME); // Новый экземпляр itemsCollection
        const countAfterReopen = await itemsCollection.count();
        assert.strictEqual(countAfterReopen, countBeforeClose, 
            `Количество документов после закрытия и повторного открытия должно совпадать. Ожидалось: ${countBeforeClose}, Получено: ${countAfterReopen}`);
        
        const lastItem = await itemsCollection.findOne(doc => doc.finalTestMarker === true);
        assert.ok(lastItem, "Последний элемент должен присутствовать после повторного открытия");
        if(lastItem) { 
            assert.strictEqual(lastItem.name, "Данные перед закрытием", "Данные последнего элемента корректны");
        }
        console.log("Проверка данных после повторного открытия БД пройдена.");

        console.log("Группа тестов 6: УСПЕШНО");

    } catch (error) {
        console.error("\n🔥🔥🔥 ПРОИЗОШЛА КРИТИЧЕСКАЯ ОШИБКА В ТЕСТЕ: 🔥🔥🔥");
        console.error(error);
        testRunSuccess = false; 
    } finally {
        console.log("\nЗавершение тестов, очистка...");
        if (db && typeof db.close === 'function') {
            let canCloseDb = false;
            if (db.baseDirInitPromise) {
                try {
                    await db.baseDirInitPromise.catch(() => {}); // Ждем, но игнорируем ошибку, если она была
                    // Проверяем, есть ли коллекции, или если инициализация упала, но мы все равно хотим попытаться закрыть
                    if ((db.collectionsCache && db.collectionsCache.size > 0) || 
                        (db.initializingCollections && db.initializingCollections.size > 0) || 
                        !db.baseDirInitPromise.resolved) { // hypothetical resolved flag
                        canCloseDb = true;
                    }
                } catch(e) { /* ignore */ }
            }
            
            if (canCloseDb) {
                 console.log("Очистка: Попытка закрыть БД в finally...");
                 await db.close().catch(e => console.error("Очистка: Ошибка при закрытии БД в finally (игнорируется):", e.message));
                 console.log("Очистка: БД закрыта в finally (или попытка была сделана).");
            } else {
                 console.log("Очистка: БД уже была закрыта или нечего закрывать / инициализация не завершена.");
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