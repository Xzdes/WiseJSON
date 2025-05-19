// durability-test-wise-json.js
const WiseJSON = require('wise-json-db');
const path = require('path');
const fs = require('fs/promises');
const assert = require('assert').strict;
const { v4: uuidv4 } = require('uuid');

const TEST_DB_ROOT_DURABILITY = path.join(__dirname, 'test_db_data_durability');

// --- Глобальные переменные для статистики ---
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failedTestDetails = [];

// --- Вспомогательные функции ---
async function describe(title, fn) {
    console.log(`\n🛡️  Тестовый Блок: ${title}`);
    await fn();
}

async function it(title, fn) {
    totalTests++;
    console.log(`  👉 Тест: ${title}`);
    await cleanupTestDB(); // Очистка ПЕРЕД каждым 'it' блоком для полной изоляции
    try {
        await fn();
        console.log(`    ✅ PASSED`);
        passedTests++;
    } catch (error) {
        console.error(`    ❌ FAILED`);
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`       Error: ${errorMessage}`);
        if (error.stack && error instanceof Error && !errorMessage.includes(error.stack.split('\n')[1].trim())) {
            // console.error(`       Stack: ${error.stack}`); 
        }
        failedTests++;
        failedTestDetails.push({ description: title, error: errorMessage, stack: error instanceof Error ? error.stack : null });
    }
}

async function cleanupTestDB() {
    try {
        await fs.rm(TEST_DB_ROOT_DURABILITY, { recursive: true, force: true });
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('Предупреждение: Ошибка при очистке тестовой директории:', error.message);
        }
    }
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readFileContent(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null; 
    }
}

function getPaths(collPath, collName, index = 0) {
    const baseName = `${collName}_${index}`;
    return {
        collPath,
        mainP: path.join(collPath, `${baseName}.json`),
        bakP: path.join(collPath, `${baseName}.json.bak`),
        newP: path.join(collPath, `${baseName}.json.new`),
        // tmp файлы будут иметь uuid, их сложнее предсказать, но _recoverSegments их найдет
    };
}

// --- Основная тестовая функция ---
async function runDurabilityTests() {
    console.log('🚀 Запуск УСИЛЕННЫХ тестов на ПРОЧНОСТЬ и ВОССТАНОВЛЕНИЕ для WiseJSON...\n');
    
    // ====================================================================================
    // Сценарии восстановления при инициализации
    // ====================================================================================
    await describe('Восстановление состояния коллекции при инициализации', async () => {
        
        await it('должен корректно инициализировать пустую коллекцию (создает _0.json)', async () => {
            const db = new WiseJSON(TEST_DB_ROOT_DURABILITY);
            const collName = 'empty_init';
            const coll = await db.collection(collName);
            const paths = getPaths(coll.collectionDirectoryPath, collName);

            assert(await pathExists(paths.collPath), 'Директория коллекции должна быть создана');
            assert(await pathExists(paths.mainP), `Файл ${path.basename(paths.mainP)} должен быть создан`);
            
            const content = await readFileContent(paths.mainP);
            assert.deepStrictEqual(content, [], `Содержимое ${path.basename(paths.mainP)} должно быть пустым массивом`);
            
            const data = await coll.getAll();
            assert.strictEqual(data.length, 0, 'Пустая коллекция должна содержать 0 элементов');
        });

        await it('должен восстановить .json из .bak, если .json отсутствует', async () => {
            const dbPath = TEST_DB_ROOT_DURABILITY;
            const collName = 'restore_from_bak_only';
            const collP = path.join(dbPath, collName); // collP - путь к директории коллекции
            await fs.mkdir(collP, { recursive: true });
            const paths = getPaths(collP, collName);

            const bakData = [{ _id: 'id_from_bak', value: 'data_from_bak' }];
            await fs.writeFile(paths.bakP, JSON.stringify(bakData));
            // .json файл НЕ создаем

            const db = new WiseJSON(dbPath);
            const coll = await db.collection(collName); // Инициализация запускает восстановление
            
            const data = await coll.getAll();
            assert.strictEqual(data.length, 1, 'Данные должны быть восстановлены из .bak (1 элемент)');
            assert.deepStrictEqual(data[0], bakData[0], 'Содержимое должно совпадать с .bak');

            assert(!(await pathExists(paths.bakP)), '.bak файл должен быть удален/переименован после восстановления');
            assert(await pathExists(paths.mainP), '.json файл должен существовать после восстановления');
        });

        await it('должен удалить .bak, если .json существует и валиден', async () => {
            const dbPath = TEST_DB_ROOT_DURABILITY;
            const collName = 'delete_bak_if_json_valid';
            const collP = path.join(dbPath, collName);
            await fs.mkdir(collP, { recursive: true });
            const paths = getPaths(collP, collName);

            const jsonData = [{ _id: 'id_json', value: 'data_from_json' }];
            const bakData = [{ _id: 'id_bak_old', value: 'old_bak_data' }];
            await fs.writeFile(paths.mainP, JSON.stringify(jsonData));
            await fs.writeFile(paths.bakP, JSON.stringify(bakData));

            const db = new WiseJSON(dbPath);
            const coll = await db.collection(collName);
            
            const data = await coll.getAll();
            assert.strictEqual(data.length, 1);
            assert.deepStrictEqual(data[0], jsonData[0], 'Данные должны быть из .json файла');

            assert(!(await pathExists(paths.bakP)), '.bak файл должен быть удален');
            assert(await pathExists(paths.mainP), '.json файл должен остаться');
        });

        await it('должен удалить осиротевший .new файл, если .json существует и валиден', async () => {
            const dbPath = TEST_DB_ROOT_DURABILITY;
            const collName = 'delete_new_if_json_valid';
            const collP = path.join(dbPath, collName);
            await fs.mkdir(collP, { recursive: true });
            const paths = getPaths(collP, collName);

            const jsonData = [{ _id: 'id_json_main', value: 'main_json_data' }];
            const newData = [{ _id: 'id_new_orphan', value: 'orphan_new_data' }];
            await fs.writeFile(paths.mainP, JSON.stringify(jsonData));
            await fs.writeFile(paths.newP, JSON.stringify(newData));

            const db = new WiseJSON(dbPath);
            const coll = await db.collection(collName);

            const data = await coll.getAll();
            assert.strictEqual(data.length, 1);
            assert.deepStrictEqual(data[0], jsonData[0], 'Данные должны быть из основного .json');

            assert(!(await pathExists(paths.newP)), '.new файл должен быть удален');
        });

        await it('должен восстановить .json из .bak и удалить .new, если .json отсутствует', async () => {
            const dbPath = TEST_DB_ROOT_DURABILITY;
            const collName = 'recover_bak_delete_new';
            const collP = path.join(dbPath, collName);
            await fs.mkdir(collP, { recursive: true });
            const paths = getPaths(collP, collName);

            const bakData = [{ _id: 'id_bak_recover', value: 'bak_is_priority' }];
            const newData = [{ _id: 'id_new_ignored', value: 'new_data_to_delete' }];
            await fs.writeFile(paths.bakP, JSON.stringify(bakData));
            await fs.writeFile(paths.newP, JSON.stringify(newData));

            const db = new WiseJSON(dbPath);
            const coll = await db.collection(collName);

            const data = await coll.getAll();
            assert.strictEqual(data.length, 1, 'Неверное количество элементов после восстановления');
            assert.deepStrictEqual(data[0], bakData[0], 'Данные должны быть восстановлены из .bak');

            assert(!(await pathExists(paths.newP)), '.new файл должен быть удален');
            assert(!(await pathExists(paths.bakP)), '.bak файл должен быть переименован/удален');
            assert(await pathExists(paths.mainP), '.json файл должен существовать');
        });
    });

    // ====================================================================================
    // Симуляция сбоев во время _writeSegmentDataInternal
    // ====================================================================================
    await describe('Надежность записи _writeSegmentDataInternal (симуляция сбоев)', async () => {
        const collName = 'sim_write_fail';
        const initialDoc = { _id: 'initial_id_abc', value: 'initial_value_xyz' };
        const updatedDocContent = [{ _id: 'updated_id_123', value: 'updated_value_789' }];
        let dbInstance; // Будет пересоздаваться
        let currentCollPath;
        let paths;

        // Хелпер для симуляции начального состояния
        async function simulateInitialWrite() {
            dbInstance = new WiseJSON(TEST_DB_ROOT_DURABILITY);
            const tempColl = await dbInstance.collection(collName);
            await tempColl.insert(initialDoc); // Записываем начальный документ
            currentCollPath = tempColl.collectionDirectoryPath;
            paths = getPaths(currentCollPath, collName, 0); // Получаем пути для сегмента 0
        }

        await it('Сбой ПОСЛЕ записи .new, ДО создания .bak (основной .json должен остаться)', async () => {
            await simulateInitialWrite();
            
            // Симулируем: writeFile в .new успешен, затем "сбой"
            await fs.writeFile(paths.newP, JSON.stringify(updatedDocContent));
            await new Promise(r => setTimeout(r, 20)); // Небольшая пауза для файловой системы

            // Переинициализация для восстановления
            const dbRecovered = new WiseJSON(TEST_DB_ROOT_DURABILITY);
            const collRecovered = await dbRecovered.collection(collName);
            const data = await collRecovered.getAll();

            assert.strictEqual(data.length, 1, 'T1: Должен остаться 1 документ');
            // Сравниваем только value, так как _id генерируется при insert
            const originalInitialDocInArray = await readFileContent(paths.mainP); // Читаем, что было в .json ДО восстановления
            assert(originalInitialDocInArray && originalInitialDocInArray.length === 1, "T1: Оригинальный mainP должен содержать 1 элемент");
            assert.strictEqual(data[0].value, originalInitialDocInArray[0].value, 'T1: Данные должны быть из оригинального .json');
            assert(!(await pathExists(paths.newP)), 'T1: .new файл должен быть удален при восстановлении');
        });

        await it('Сбой ПОСЛЕ создания .bak, ДО переименования .new в .json (восстановление из .bak)', async () => {
            await simulateInitialWrite();
            const originalInitialDocInArray = await readFileContent(paths.mainP); // Сохраняем для сравнения

            await fs.writeFile(paths.newP, JSON.stringify(updatedDocContent));
            if (await pathExists(paths.mainP)) await fs.rename(paths.mainP, paths.bakP); // .json стал .bak
            await new Promise(r => setTimeout(r, 20));

            const dbRecovered = new WiseJSON(TEST_DB_ROOT_DURABILITY);
            const collRecovered = await dbRecovered.collection(collName);
            const data = await collRecovered.getAll();
            
            assert.strictEqual(data.length, 1, 'T2: Должен остаться 1 документ');
            assert(originalInitialDocInArray && originalInitialDocInArray.length === 1, "T2: Оригинальный mainP (теперь в .bak) должен был содержать 1 элемент");
            assert.strictEqual(data[0].value, originalInitialDocInArray[0].value, 'T2: Данные должны быть восстановлены из .bak (оригинальные)');
            assert(!(await pathExists(paths.newP)), 'T2: .new файл должен быть удален');
            assert(!(await pathExists(paths.bakP)), 'T2: .bak файл должен быть переименован в .json');
            assert(await pathExists(paths.mainP), 'T2: .json файл должен существовать');
        });
        
        await it('Сбой ПОСЛЕ переименования .new в .json, ДО удаления .bak (.json новый, .bak удаляется)', async () => {
            await simulateInitialWrite();

            // Симулируем: .json (старый) -> .bak, .new -> .json
            if (await pathExists(paths.mainP)) await fs.rename(paths.mainP, paths.bakP); 
            await fs.writeFile(paths.mainP, JSON.stringify(updatedDocContent)); // Новый .json
            // Файлы: paths.mainP (новый), paths.bakP (старый)
            await new Promise(r => setTimeout(r, 20));

            const dbRecovered = new WiseJSON(TEST_DB_ROOT_DURABILITY);
            const collRecovered = await dbRecovered.collection(collName);
            const data = await collRecovered.getAll();

            assert.strictEqual(data.length, 1, 'T3: Должен быть 1 документ');
            assert.deepStrictEqual(data, updatedDocContent, 'T3: Данные должны быть из нового .json');
            assert(!(await pathExists(paths.bakP)), 'T3: .bak файл должен быть удален при восстановлении');
        });

        await it('Корректная первая запись в пустую коллекцию (нет .json, .bak, .new до операции)', async () => {
            // cleanupTestDB() уже был вызван в `it`
            const dbFirst = new WiseJSON(TEST_DB_ROOT_DURABILITY);
            const collFirst = await dbFirst.collection('first_ever_write');
            const pathsFirst = getPaths(collFirst.collectionDirectoryPath, 'first_ever_write', 0);
            
            const docToInsert = { name: 'My First Document', data: 123 };
            const inserted = await collFirst.insert(docToInsert);
            assert(inserted && inserted._id, 'T4: Документ должен быть вставлен');

            const data = await collFirst.getAll();
            assert.strictEqual(data.length, 1, 'T4: Должен быть 1 документ');
            // Сравниваем с тем, что вернул insert, так как _id, createdAt, updatedAt генерируются
            const expectedData = [{ 
                _id: inserted._id, 
                name: docToInsert.name, 
                data: docToInsert.data,
                createdAt: inserted.createdAt,
                updatedAt: inserted.updatedAt
            }];
            assert.deepStrictEqual(data, expectedData, 'T4: Данные должны быть успешно записаны');

            assert(await pathExists(pathsFirst.mainP), 'T4: Файл _0.json должен существовать');
            assert(!(await pathExists(pathsFirst.newP)), 'T4: .new не должен остаться');
            assert(!(await pathExists(pathsFirst.bakP)), 'T4: .bak не должен остаться');
        });
    });

    // ====================================================================================
    // Повторная проверка ранее добавленных фич
    // ====================================================================================
    await describe('Проверка стандартных фич после изменений для прочности', async () => {
        await cleanupTestDB(); 
        const featureDb = new WiseJSON(TEST_DB_ROOT_DURABILITY);
        await featureDb.baseDirInitPromise;

        await it('Upsert должен работать корректно', async () => {
            const upsertColl = await featureDb.collection('upsert_after_all_dur');
            const res1 = await upsertColl.upsert({key: 'upsert1'}, {val: 10}, {setOnInsert: {createdHere:true}});
            assert.strictEqual(res1.operation, 'inserted');
            assert.strictEqual(res1.document.createdHere, true);

            const res2 = await upsertColl.upsert({key: 'upsert1'}, {val: 20});
            assert.strictEqual(res2.operation, 'updated');
            assert.strictEqual(res2.document.val, 20);
            assert.strictEqual(res2.document.createdHere, true);
        });

        await it('Счетчик (count) должен работать', async () => {
            const countColl = await featureDb.collection('count_after_all_dur');
            await countColl.insert({tag:'x'});
            await countColl.insert({tag:'x'});
            await countColl.insert({tag:'y'});
            assert.strictEqual(await countColl.count(doc => doc.tag === 'x'), 2);
            assert.strictEqual(await countColl.count(), 3);
        });
        
        await it('Хуки (hooks) должны срабатывать', async () => {
            const hookColl = await featureDb.collection('hooks_after_all_dur');
            let hookFiredData = null;
            hookColl.on('afterInsert', (doc) => { hookFiredData = doc; });
            const insertedByHookTest = await hookColl.insert({label:'hook_trigger'});
            await new Promise(r => setTimeout(r, 50)); 
            assert(hookFiredData, 'Хук afterInsert должен был быть вызван');
            assert.strictEqual(hookFiredData._id, insertedByHookTest._id);
            assert.strictEqual(hookFiredData.label, 'hook_trigger');
        });
    });

    // --- Вывод итогов ---
    console.log('\n\n--- Итоги Тестов на ПРОЧНОСТЬ ---');
    console.log(`Всего тестов запущено: ${totalTests}`);
    console.log(`✅ Пройдено: ${passedTests}`);
    console.log(`❌ Провалено: ${failedTests}`);

    if (failedTests > 0) {
        console.error('\n🔥🔥🔥 ЕСТЬ ПРОВАЛЕННЫЕ ТЕСТЫ НА ПРОЧНОСТЬ! 🔥🔥🔥');
        failedTestDetails.forEach(fail => {
            console.error(`\n  Описание: ${fail.description}`);
            console.error(`  Ошибка: ${fail.error}`);
        });
    } else if (totalTests > 0) {
        console.log('\n🎉🎉🎉 ВСЕ ТЕСТЫ НА ПРОЧНОСТЬ ПРОЙДЕНЫ УСПЕШНО! 🎉🎉🎉');
    } else {
        console.warn("\n⚠️ Не было запущено ни одного теста на прочность (или ошибка инициализации).");
    }
}

runDurabilityTests().catch(err => {
    console.error("КРИТИЧЕСКАЯ ОШИБКА ВНЕ ТЕСТОВОГО СЦЕНАРИЯ (ПРОЧНОСТЬ):", err);
}).finally(() => {
    if (totalTests === 0 && passedTests === 0 && failedTests === 0) { 
        const initialDescribeError = failedTestDetails.find(f => f.description.includes("Инициализация WiseJSON"));
        if(initialDescribeError) return;
        console.error("Тесты на прочность не были запущены из-за критической ошибки на раннем этапе.");
    }
});