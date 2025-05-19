// test-wise-json.js
const WiseJSON = require('wise-json-db'); // Используем имя пакета
const path = require('path');
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid'); // <-- ДОБАВИТЬ ЭТУ СТРОКУ

const TEST_DB_ROOT = path.join(__dirname, 'test_db_data_simple'); // Новая папка для этого теста

// --- Вспомогательные функции для тестов ---
let testCounter = 0;
let assertionsPassed = 0;
let assertionsFailed = 0;

async function assert(condition, message) {
    testCounter++;
    if (condition) {
        console.log(`✅ PASSED: ${message}`);
        assertionsPassed++;
    } else {
        console.error(`❌ FAILED: ${message}`);
        assertionsFailed++;
    }
}

async function cleanupTestDB() {
    try {
        await fs.rm(TEST_DB_ROOT, { recursive: true, force: true });
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Ошибка при очистке тестовой директории (простой тест):', error);
        }
    }
}

// --- Основная функция для запуска тестов ---
async function runSimpleTests() {
    console.log('🚀 Запуск ПРОСТЫХ тестов для WiseJSON...\n');
    await cleanupTestDB();

    let db;

    // --- Тесты для WiseJSON (основной класс) ---
    console.log('\n--- Тестирование WiseJSON (основной класс) ---');
    try {
        db = new WiseJSON(TEST_DB_ROOT);
        await db.baseDirInitPromise;
        await assert(true, 'WiseJSON: Успешная инициализация и создание базовой директории');
    } catch (e) {
        await assert(false, `WiseJSON: Ошибка инициализации: ${e.message}`);
        console.error(e);
        // Выводим итоги и выходим, если база не инициализировалась
        console.log('\n--- Результаты Тестов ---');
        console.log(`Всего проверок: ${testCounter}`);
        console.log(`✅ Пройдено: ${assertionsPassed}`);
        console.log(`❌ Провалено: ${assertionsFailed > 0 ? assertionsFailed : 1}`);
        return;
    }

   try {
        const productsCollection = await db.collection('products_simple');
        await assert(
            typeof productsCollection === 'object' && productsCollection !== null && typeof productsCollection.insert === 'function', 
            'WiseJSON: collection() возвращает объект коллекции с методом insert'
        );
        
        const productsCollectionAgain = await db.collection('products_simple');
        await assert(productsCollection === productsCollectionAgain, 'WiseJSON: collection() возвращает кэшированный экземпляр');

        try {
            await fs.access(path.join(TEST_DB_ROOT, 'products_simple'));
            await assert(true, 'WiseJSON: Директория для коллекции "products_simple" создана');
        } catch (e) {
            await assert(false, `WiseJSON: Директория для коллекции "products_simple" НЕ создана: ${e.message}`);
        }

    } catch (e) {
        await assert(false, `WiseJSON: Ошибка при работе с методом collection(): ${e.message}`);
        console.error(e);
    }

    // --- Тесты для Collection ---
    console.log('\n--- Тестирование Collection (базовый CRUD) ---');
    if (!db || assertionsFailed > 0) { // Прерываем, если были ошибки
        console.error("Прерывание тестов Collection из-за предыдущих ошибок.");
        // Выводим итоги и выходим
        console.log('\n--- Результаты Тестов ---');
        console.log(`Всего проверок: ${testCounter}`);
        console.log(`✅ Пройдено: ${assertionsPassed}`);
        console.log(`❌ Провалено: ${assertionsFailed}`);
        return;
    }


    const itemsCollection = await db.collection('items_simple', { maxSegmentSizeBytes: 150, jsonIndent: 0 });
    let item1, item2;

    // 1. Тест insert()
    try {
        const data1 = { name: 'Простой Предмет 1', value: 10 };
        item1 = await itemsCollection.insert(data1);
        await assert(item1 && item1._id && item1.name === data1.name && item1.value === data1.value, 
                     'Collection.insert(): Успешная вставка первого предмета');

        const data2 = { name: 'Простой Предмет 2', value: 20, tags: ['test', 'basic'] };
        item2 = await itemsCollection.insert(data2);
        await assert(item2 && item2._id && item2.name === data2.name && item2.tags && item2.tags.includes('basic'), 
                     'Collection.insert(): Успешная вставка второго предмета с доп. полями');
    } catch (e) {
        await assert(false, `Collection.insert(): Ошибка при вставке: ${e.message}`);
        console.error(e);
    }
    
    // 2. Тест getById()
    if (item1 && item1._id) { // Убедимся, что item1 был успешно создан
        try {
            const foundItem1 = await itemsCollection.getById(item1._id);
            await assert(foundItem1 && foundItem1.name === item1.name, 'Collection.getById(): Успешный поиск существующего предмета');
            
            const notFoundItem = await itemsCollection.getById('non-existent-id-simple');
            await assert(notFoundItem === null, 'Collection.getById(): Возвращает null для несуществующего ID');
        } catch (e) {
            await assert(false, `Collection.getById(): Ошибка при поиске: ${e.message}`);
            console.error(e);
        }
    } else {
        await assert(false, 'Collection.getById(): Пропуск теста, item1 не был создан.');
    }

    // 3. Тест getAll()
    try {
        const allItems = await itemsCollection.getAll();
        // Ожидаем 2 элемента, если обе предыдущие вставки были успешны
        const expectedCount = (item1 && item1._id ? 1 : 0) + (item2 && item2._id ? 1 : 0);
        await assert(Array.isArray(allItems) && allItems.length === expectedCount, 
                     `Collection.getAll(): Должен вернуть ${expectedCount} вставленных предметов. Получено: ${allItems.length}`);
    } catch (e) {
        await assert(false, `Collection.getAll(): Ошибка: ${e.message}`);
        console.error(e);
    }

    // 4. Тест find() и findOne()
    if (item1 && item1._id && item2 && item2._id) { // Убедимся, что оба существуют
        try {
            const itemsWithValue10 = await itemsCollection.find(item => item.value === 10);
            await assert(itemsWithValue10.length === 1 && itemsWithValue10[0].name === item1.name, 'Collection.find(): Поиск по значению');

            const itemWithTagBasic = await itemsCollection.findOne(item => item.tags && item.tags.includes('basic'));
            await assert(itemWithTagBasic && itemWithTagBasic.name === item2.name, 'Collection.findOne(): Поиск по тегу');
            
            const nonExistentFind = await itemsCollection.findOne(item => item.value === 9999);
            await assert(nonExistentFind === null, 'Collection.findOne(): Возвращает null если ничего не найдено');
        } catch (e) {
            await assert(false, `Collection.find()/findOne(): Ошибка: ${e.message}`);
            console.error(e);
        }
    } else {
         await assert(false, 'Collection.find()/findOne(): Пропуск теста, не все нужные элементы были созданы.');
    }

    // 5. Тест update()
    if (item2 && item2._id) { // Убедимся, что item2 существует
        try {
            const originalUpdatedAt = item2.updatedAt;
            const updatedItem2 = await itemsCollection.update(item2._id, { value: 25, status: 'updated_simple' });
            await assert(updatedItem2 && updatedItem2.value === 25 && updatedItem2.status === 'updated_simple', 'Collection.update(): Успешное обновление');
            await assert(updatedItem2.updatedAt !== originalUpdatedAt, 'Collection.update(): Поле updatedAt обновлено');

            const fetchedUpdatedItem2 = await itemsCollection.getById(item2._id);
            await assert(fetchedUpdatedItem2 && fetchedUpdatedItem2.value === 25, 'Collection.update(): Изменения сохранены');
            
            const nonExistentUpdate = await itemsCollection.update('non-existent-id-simple-update', { value: 1 });
            await assert(nonExistentUpdate === null, 'Collection.update(): Возвращает null при обновлении несуществующего ID');
        } catch (e) {
            await assert(false, `Collection.update(): Ошибка: ${e.message}`);
            console.error(e);
        }
    } else {
        await assert(false, 'Collection.update(): Пропуск теста, item2 не был создан.');
    }

    // 6. Тест remove()
    if (item1 && item1._id && item2 && item2._id) { // Убедимся, что оба существуют для этого сценария
        try {
            const wasRemoved1 = await itemsCollection.remove(item1._id);
            await assert(wasRemoved1 === true, 'Collection.remove(): Успешное удаление item1');

            const removedItem1Check = await itemsCollection.getById(item1._id);
            await assert(removedItem1Check === null, 'Collection.remove(): Удаленный item1 не находится');

            const allItemsAfterRemove = await itemsCollection.getAll();
            // Теперь должен остаться только item2 (если он не был удален в другом тесте - поэтому лучше изолировать)
            // Для данного простого теста, мы ожидаем, что остался item2
            const item2StillExists = allItemsAfterRemove.find(i => i._id === item2._id);
            await assert(allItemsAfterRemove.length === 1 && item2StillExists, 
                         `Collection.remove(): getAll() должен показывать 1 элемент (item2). Найдено: ${allItemsAfterRemove.length}`);
            
            const nonExistentRemove = await itemsCollection.remove('non-existent-id-simple-remove');
            await assert(nonExistentRemove === false, 'Collection.remove(): Возвращает false при удалении несуществующего ID');

        } catch (e) {
            await assert(false, `Collection.remove(): Ошибка: ${e.message}`);
            console.error(e);
        }
    } else {
         await assert(false, 'Collection.remove(): Пропуск теста, не все нужные элементы были созданы/остались.');
    }
    
    // 7. Тест Сегментации (проверка доступности данных после множества вставок)
    console.log('\n--- Тестирование Сегментации (простой тест) ---');
    // Создадим новую коллекцию для этого теста, чтобы не зависеть от предыдущих данных
    const segmentTestCollection = await db.collection('segment_simple_verify', { maxSegmentSizeBytes: 100, jsonIndent: 0 }); 
    let totalItemsForSegmentTest = 0;
    const itemsToVerifyInSegments = [];

    try {
        for (let i = 0; i < 5; i++) { // 5 элементов должно точно вызвать сегментацию при max 100 байт
            const newItem = await segmentTestCollection.insert({ 
                name: `Сегмент Элемент ${i}`, 
                data: `Некоторые данные для заполнения ${uuidv4()}` // uuid для уникальности и размера
            });
            assert(newItem && newItem._id, `Сегментация: Вставка элемента ${i} успешна`);
            itemsToVerifyInSegments.push(newItem);
            totalItemsForSegmentTest++;
        }
        
        const allSegmentedItems = await segmentTestCollection.getAll();
        await assert(allSegmentedItems.length === totalItemsForSegmentTest, 
            `Сегментация: getAll() должен вернуть все ${totalItemsForSegmentTest} вставленных элементов. Получено: ${allSegmentedItems.length}`);

        for (const insertedItem of itemsToVerifyInSegments) {
            const found = allSegmentedItems.find(item => item._id === insertedItem._id);
            await assert(found && found.name === insertedItem.name, 
                         `Сегментация: Элемент ${insertedItem._id} (${insertedItem.name}) должен быть найден и корректен.`);
        }
    } catch (e) {
        await assert(false, `Сегментация: Ошибка: ${e.message}`);
        console.error(e);
    }

    // 8. Тест работы очереди записи (простой)
    console.log('\n--- Тестирование Очереди Записи (простой тест) ---');
    const raceCollection = await db.collection('race_items_simple');
    try {
        const promises = [];
        const numInserts = 10; // Немного увеличим
        for (let i = 0; i < numInserts; i++) {
            promises.push(raceCollection.insert({ name: `Гонка ${i}`, order: i }));
        }
        const results = await Promise.allSettled(promises);
        
        let successfulInserts = 0;
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value && result.value._id) {
                successfulInserts++;
            } else if (result.status === 'rejected') {
                console.error("Ошибка при параллельной вставке (очередь):", result.reason);
            }
        });
        await assert(successfulInserts === numInserts, `Очередь Записи: Все ${numInserts} вставок должны быть успешными. Успешно: ${successfulInserts}`);
        
        const raceItems = await raceCollection.getAll();
        await assert(raceItems.length === numInserts, `Очередь Записи: Итоговое количество элементов ${numInserts}. Найдено: ${raceItems.length}`);
        
    } catch (e) {
        await assert(false, `Очередь Записи: Ошибка: ${e.message}`);
        console.error(e);
    }

    // --- Завершение тестов ---
    console.log('\n--- Результаты Тестов ---');
    console.log(`Всего проверок: ${testCounter}`);
    console.log(`✅ Пройдено: ${assertionsPassed}`);
    console.log(`❌ Провалено: ${assertionsFailed}`);

    if (assertionsFailed > 0) {
        console.error('\n🔥🔥🔥 ЕСТЬ ПРОВАЛЕННЫЕ ТЕСТЫ! 🔥🔥🔥');
    } else {
        console.log('\n🎉🎉🎉 ВСЕ ПРОСТЫЕ ТЕСТЫ ПРОЙДЕНЫ УСПЕШНО! 🎉🎉🎉');
    }
}

// Запускаем тесты
runSimpleTests().catch(err => {
    console.error("Критическая ошибка во время выполнения простых тестов:", err);
    // process.exit(1); // Можно добавить для CI
});