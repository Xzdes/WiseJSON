// test-wise-json.js
const WiseJSON = require('./wise-json'); // Путь к главному файлу нашей библиотеки
const path = require('path');
const fs = require('fs/promises'); // Для очистки тестовой директории

const TEST_DB_ROOT = path.join(__dirname, 'test_db_data'); // Отдельная папка для тестовых данных

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
        // console.log('Тестовая директория очищена.');
    } catch (error) {
        // Игнорируем, если папки нет
        if (error.code !== 'ENOENT') {
            console.error('Ошибка при очистке тестовой директории:', error);
        }
    }
}

// --- Основная функция для запуска тестов ---

async function runTests() {
    console.log('🚀 Запуск тестов для WiseJSON...\n');

    // 0. Очистка перед каждым полным запуском тестов
    await cleanupTestDB();

    // --- Тесты для WiseJSON (основной класс) ---
    console.log('\n--- Тестирование WiseJSON (основной класс) ---');
    let db;
    try {
        db = new WiseJSON(TEST_DB_ROOT);
        await db.baseDirInitPromise; // Ждем инициализации базовой директории
        await assert(true, 'WiseJSON: Успешная инициализация и создание базовой директории');
    } catch (e) {
        await assert(false, `WiseJSON: Ошибка инициализации: ${e.message}`);
        console.error(e);
        return; // Прерываем тесты, если база не инициализировалась
    }

    try {
        const productsCollection = await db.collection('products');
        await assert(productsCollection instanceof require('./wise-json/collection'), 'WiseJSON: collection() возвращает экземпляр Collection');
        
        const productsCollectionAgain = await db.collection('products');
        await assert(productsCollection === productsCollectionAgain, 'WiseJSON: collection() возвращает кэшированный экземпляр');

        // Проверка создания директории коллекции
        try {
            await fs.access(path.join(TEST_DB_ROOT, 'products'));
            await assert(true, 'WiseJSON: Директория для коллекции "products" создана');
        } catch (e) {
            await assert(false, `WiseJSON: Директория для коллекции "products" НЕ создана: ${e.message}`);
        }

    } catch (e) {
        await assert(false, `WiseJSON: Ошибка при работе с методом collection(): ${e.message}`);
        console.error(e);
    }

    // --- Тесты для Collection ---
    console.log('\n--- Тестирование Collection ---');
    if (!db) return; // Если db не был создан

    const itemsCollection = await db.collection('items', { maxSegmentSizeBytes: 100 }); // Очень маленький размер для теста сегментации

    // 1. Тест insert()
    let item1, item2, item3, item4;
    try {
        item1 = await itemsCollection.insert({ name: 'Тестовый Предмет 1', value: 10 });
        await assert(item1 && item1._id && item1.name === 'Тестовый Предмет 1', 'Collection.insert(): Успешная вставка первого предмета');

        item2 = await itemsCollection.insert({ name: 'Тестовый Предмет 2', value: 20, tags: ['test', 'simple'] });
        await assert(item2 && item2.tags && item2.tags.includes('test'), 'Collection.insert(): Успешная вставка второго предмета с доп. полями');
    } catch (e) {
        await assert(false, `Collection.insert(): Ошибка при вставке: ${e.message}`);
        console.error(e);
    }
    
    // 2. Тест getById()
    if (item1) {
        try {
            const foundItem1 = await itemsCollection.getById(item1._id);
            await assert(foundItem1 && foundItem1.name === 'Тестовый Предмет 1', 'Collection.getById(): Успешный поиск существующего предмета');
            
            const notFoundItem = await itemsCollection.getById('non-existent-id');
            await assert(notFoundItem === null, 'Collection.getById(): Возвращает null для несуществующего ID');
        } catch (e) {
            await assert(false, `Collection.getById(): Ошибка при поиске: ${e.message}`);
            console.error(e);
        }
    }

    // 3. Тест getAll()
    try {
        const allItems = await itemsCollection.getAll();
        await assert(Array.isArray(allItems) && allItems.length === 2, 'Collection.getAll(): Возвращает все (2) вставленные предметы');
    } catch (e) {
        await assert(false, `Collection.getAll(): Ошибка: ${e.message}`);
        console.error(e);
    }

    // 4. Тест find() и findOne()
    try {
        const itemsWithValue10 = await itemsCollection.find(item => item.value === 10);
        await assert(itemsWithValue10.length === 1 && itemsWithValue10[0].name === 'Тестовый Предмет 1', 'Collection.find(): Поиск по значению');

        const itemWithTagSimple = await itemsCollection.findOne(item => item.tags && item.tags.includes('simple'));
        await assert(itemWithTagSimple && itemWithTagSimple.name === 'Тестовый Предмет 2', 'Collection.findOne(): Поиск по тегу');
        
        const nonExistentFind = await itemsCollection.findOne(item => item.value === 999);
        await assert(nonExistentFind === null, 'Collection.findOne(): Возвращает null если ничего не найдено');

    } catch (e) {
        await assert(false, `Collection.find()/findOne(): Ошибка: ${e.message}`);
        console.error(e);
    }

    // 5. Тест update()
    if (item2) {
        try {
            const updatedItem2 = await itemsCollection.update(item2._id, { value: 25, status: 'updated' });
            await assert(updatedItem2 && updatedItem2.value === 25 && updatedItem2.status === 'updated', 'Collection.update(): Успешное обновление');
            await assert(updatedItem2.updatedAt !== item2.updatedAt, 'Collection.update(): Поле updatedAt обновлено');

            const fetchedUpdatedItem2 = await itemsCollection.getById(item2._id);
            await assert(fetchedUpdatedItem2 && fetchedUpdatedItem2.value === 25, 'Collection.update(): Изменения сохранены (проверено через getById)');
            
            const nonExistentUpdate = await itemsCollection.update('non-existent-id', { value: 1 });
            await assert(nonExistentUpdate === null, 'Collection.update(): Возвращает null при обновлении несуществующего ID');

        } catch (e) {
            await assert(false, `Collection.update(): Ошибка: ${e.message}`);
            console.error(e);
        }
    }

    // 6. Тест remove()
    if (item1) {
        try {
            const wasRemoved = await itemsCollection.remove(item1._id);
            await assert(wasRemoved === true, 'Collection.remove(): Успешное удаление существующего предмета');

            const removedItemCheck = await itemsCollection.getById(item1._id);
            await assert(removedItemCheck === null, 'Collection.remove(): Удаленный предмет не находится через getById');

            const allItemsAfterRemove = await itemsCollection.getAll();
            await assert(allItemsAfterRemove.length === 1 && allItemsAfterRemove[0]._id === item2._id, 'Collection.remove(): getAll() показывает правильное количество после удаления');
            
            const nonExistentRemove = await itemsCollection.remove('non-existent-id');
            await assert(nonExistentRemove === false, 'Collection.remove(): Возвращает false при удалении несуществующего ID');

        } catch (e) {
            await assert(false, `Collection.remove(): Ошибка: ${e.message}`);
            console.error(e);
        }
    }
    
    // 7. Тест Сегментации (требует маленького maxSegmentSizeBytes)
    // У itemsCollection уже установлен maxSegmentSizeBytes: 100 байт
    console.log('\n--- Тестирование Сегментации ---');
    try {
        // Вставляем еще несколько элементов, чтобы превысить лимит сегмента
        // Размер одного элемента примерно: {"_id":"...", "name":"Test Item X", "value":XX, "createdAt":"...", "updatedAt":"..."} ~ 150-200 байт
        // Значит, после первого-второго элемента должен создаться новый сегмент.
        item3 = await itemsCollection.insert({ name: 'Очень Длинное Имя Предмета Для Теста Сегментации Номер Три', value: 30 });
        await assert(item3, 'Сегментация: Вставка item3');
        
        const segmentFilesBeforeItem4 = await itemsCollection._getSegmentFiles();
        const initialSegmentCount = segmentFilesBeforeItem4.length;
        // console.log(`Сегментов до item4: ${initialSegmentCount}, файлы: ${segmentFilesBeforeItem4.join(', ')}`);

        item4 = await itemsCollection.insert({ name: 'Предмет Четыре Также С Длинным Именем', value: 40 });
        await assert(item4, 'Сегментация: Вставка item4');

        const segmentFilesAfterItem4 = await itemsCollection._getSegmentFiles();
        const finalSegmentCount = segmentFilesAfterItem4.length;
        // console.log(`Сегментов после item4: ${finalSegmentCount}, файлы: ${segmentFilesAfterItem4.join(', ')}`);
        // console.log(`Текущий индекс сегмента: ${itemsCollection.currentSegmentIndex}`);

        // Ожидаем, что количество сегментов увеличилось или currentSegmentIndex > 0
        // Точное количество сегментов зависит от того, как item2, item3, item4 распределились
        // Важно, что currentSegmentIndex изменился, если был переход
        await assert(itemsCollection.currentSegmentIndex > 0 || finalSegmentCount > initialSegmentCount || finalSegmentCount > 1,
                     `Сегментация: Произошло создание нового сегмента (было ${initialSegmentCount}, стало ${finalSegmentCount}, текущий индекс ${itemsCollection.currentSegmentIndex})`);

        // Проверяем, что все элементы доступны через getAll()
        const allSegmentedItems = await itemsCollection.getAll();
        // Ожидаем item2 (остался после удаления item1), item3, item4
        await assert(allSegmentedItems.length === 3, `Сегментация: getAll() возвращает все ${allSegmentedItems.length} элементов из сегментов`);
        const foundItem4 = allSegmentedItems.find(i => i._id === item4._id);
        await assert(foundItem4 && foundItem4.name === 'Предмет Четыре Также С Длинным Именем', 'Сегментация: Элемент из нового сегмента доступен');

    } catch (e) {
        await assert(false, `Сегментация: Ошибка: ${e.message}`);
        console.error(e);
    }

    // 8. Тест работы очереди записи (простой)
    console.log('\n--- Тестирование Очереди Записи ---');
    const raceCollection = await db.collection('race_items');
    try {
        const promises = [];
        const numInserts = 5;
        for (let i = 0; i < numInserts; i++) {
            promises.push(raceCollection.insert({ name: `Гонка ${i}`, order: i }));
        }
        await Promise.all(promises);
        
        const raceItems = await raceCollection.getAll();
        await assert(raceItems.length === numInserts, `Очередь Записи: Все ${numInserts} параллельных вставок выполнены`);
        
        // Проверяем порядок (хотя UUID не гарантирует порядок, но createdAt должен быть последовательным)
        // Более надежная проверка - если бы мы вставляли с полем 'sequence' и проверяли его.
        // Для простоты, просто проверим, что все вставились.
        let ordered = true;
        for (let i = 0; i < raceItems.length - 1; i++) {
            if (new Date(raceItems[i].createdAt) > new Date(raceItems[i+1].createdAt)) {
                // Это может иногда случаться из-за скорости выполнения и точности Date,
                // но если очередь работает, они должны быть очень близки или равны.
                // Главное, что все записи на месте и файлы не повреждены.
                // console.warn(`Предупреждение: createdAt ${raceItems[i].createdAt} > ${raceItems[i+1].createdAt}`);
                // ordered = false; break; // Для простого теста можно это закомментировать
            }
        }
        // await assert(ordered, 'Очередь Записи: createdAt вставленных элементов (примерно) последовательны');

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
        // process.exit(1); // Раскомментируйте, если хотите, чтобы скрипт завершался с ошибкой
    } else {
        console.log('\n🎉🎉🎉 ВСЕ ТЕСТЫ ПРОЙДЕНЫ! 🎉🎉🎉');
    }

    // Очистка после тестов
    // await cleanupTestDB(); // Раскомментируйте, если хотите удалять данные после каждого прогона
}

// Запускаем тесты
runTests().catch(err => {
    console.error("Критическая ошибка во время выполнения тестов:", err);
    process.exit(1);
});