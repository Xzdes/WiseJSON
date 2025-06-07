// test/db-advanced-scenarios.js

const path = require('path');
const fs = require('fs/promises'); // Используем промисы для асинхронных операций fs
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');
const { cleanupExpiredDocs } = require('../wise-json/collection/ttl.js'); // Импортируем измененную версию
const { getWalPath, initializeWal, appendWalEntry, readWal } = require('../wise-json/wal-manager.js');
const { loadLatestCheckpoint, cleanupOldCheckpoints } = require('../wise-json/checkpoint-manager.js');

const DB_ROOT_PATH = path.resolve(__dirname, 'db-advanced-test-data');
const COLLECTION_NAME = 'advanced_tests_col';

async function cleanUpDbDirectory(dbPath) {
    try {
        const exists = await fs.stat(dbPath).then(() => true).catch(() => false);
        if (exists) {
            await fs.rm(dbPath, { recursive: true, force: true });
            // console.log(`[Test Cleanup] Directory ${dbPath} removed.`);
        }
    } catch (error) {
        // Если директории нет, fs.rm выбросит ошибку, это нормально и можно проигнорировать
        if (error.code !== 'ENOENT') {
            console.error(`[Test Cleanup] Error removing directory ${dbPath}:`, error);
        }
    }
}

async function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

async function testTtlEdgeCases() {
    console.log('  --- Running TTL Edge Cases Test ---');
    const dbPath = path.join(DB_ROOT_PATH, 'ttl_edge');
    await cleanUpDbDirectory(dbPath);

    const db = new WiseJSON(dbPath, { ttlCleanupIntervalMs: 20000 }); // Увеличим интервал, чтобы не мешал тесту
    await db.init();
    const col = await db.collection(COLLECTION_NAME);
    await col.initPromise;

    const now = Date.now();
    const createdAtISO = new Date(now).toISOString();

    // Вставляем документы
    await col.insert({ _id: 'expired_past', data: 'past', expireAt: now - 10000 }); // Истекший
    await col.insert({ _id: 'invalid_expire', data: 'invalid', expireAt: 'not-a-date' }); // Невалидная дата, должен остаться
    await col.insert({ _id: 'ttl_zero', data: 'zero_ttl', ttl: 0, createdAt: new Date(now - 1).toISOString() }); // TTL 0, должен истечь
    await col.insert({ _id: 'ttl_short', data: 'short_ttl', ttl: 200, createdAt: createdAtISO }); // Короткий TTL
    await col.insert({ _id: 'normal_doc', data: 'normal' }); // Обычный документ, должен остаться
    await col.insert({ _id: 'null_expire', data: 'null_expire', expireAt: null }); // expireAt: null, должен остаться
    await col.insert({ _id: 'undefined_ttl', data: 'undefined_ttl', ttl: undefined, createdAt: createdAtISO }); // ttl: undefined, должен остаться


    // Проверяем col.documents.size напрямую до любого cleanup'а
    assert.strictEqual(col.documents.size, 7, 'Initial raw document count in map should be 7');

    // Первый вызов col.count() вызовет cleanupExpiredDocs внутри себя
    // Ожидаем:
    // - 'expired_past' удален
    // - 'ttl_zero' удален
    // - 'invalid_expire' остался (из-за новой логики isAlive)
    // - 'ttl_short' остался (еще не истек)
    // - 'normal_doc' остался
    // - 'null_expire' остался
    // - 'undefined_ttl' остался
    // Итого: 7 - 2 = 5
    assert.strictEqual(await col.count(), 5, 'Count after first cleanup (expired_past, ttl_zero removed)');

    // Проверяем оставшиеся документы
    let docInvalid = await col.getById('invalid_expire');
    assert.ok(docInvalid, 'Document with invalid expireAt should remain after first count');
    let docShort = await col.getById('ttl_short');
    assert.ok(docShort, 'Document with short TTL should still be there');
    let docNormal = await col.getById('normal_doc');
    assert.ok(docNormal, 'Normal document should be there');
    let docNullExpire = await col.getById('null_expire');
    assert.ok(docNullExpire, 'Document with null expireAt should remain');
    let docUndefinedTtl = await col.getById('undefined_ttl');
    assert.ok(docUndefinedTtl, 'Document with undefined ttl should remain');

    // Ждем, пока 'ttl_short' истечет
    await sleep(300); // 200ms TTL + небольшой запас

    // Явный cleanup для теста (таймер TTL может сработать, а может и нет, в зависимости от точности setTimeout)
    const removedCount = cleanupExpiredDocs(col.documents, col._indexManager);
    // console.log(`[TTL Test] Docs removed by explicit cleanup: ${removedCount}`); // Ожидаем 1 (ttl_short)

    // Теперь 'ttl_short' должен быть удален.
    // Остаются: 'invalid_expire', 'normal_doc', 'null_expire', 'undefined_ttl'
    // Итого: 5 - 1 = 4
    assert.strictEqual(await col.count(), 4, 'Final count after short TTL expired and explicit cleanup');

    // Финальные проверки для каждого документа
    const docPast = await col.getById('expired_past');
    assert.strictEqual(docPast, null, 'Document with past expireAt should be removed');

    docInvalid = await col.getById('invalid_expire');
    assert.ok(docInvalid, 'Document with invalid expireAt should remain');
    assert.strictEqual(docInvalid.data, 'invalid', 'Invalid expireAt data check');

    const docTtlZero = await col.getById('ttl_zero');
    assert.strictEqual(docTtlZero, null, 'Document with ttl: 0 should be removed');

    const docTtlShortAfterWait = await col.getById('ttl_short');
    assert.strictEqual(docTtlShortAfterWait, null, 'Document with short ttl should be removed after wait');
    
    docNormal = await col.getById('normal_doc');
    assert.ok(docNormal, 'Normal document should still be there');
    
    docNullExpire = await col.getById('null_expire');
    assert.ok(docNullExpire, 'Document with null expireAt should still be there after all cleanups');

    docUndefinedTtl = await col.getById('undefined_ttl');
    assert.ok(docUndefinedTtl, 'Document with undefined ttl should still be there after all cleanups');

    await db.close();
    await cleanUpDbDirectory(dbPath);
    console.log('  --- TTL Edge Cases Test PASSED ---');
}

async function testCorruptedWalRecovery() {
    console.log('  --- Running Corrupted WAL Recovery Test ---');
    const dbPath = path.join(DB_ROOT_PATH, 'wal_corrupt');
    await cleanUpDbDirectory(dbPath);

    const colDir = path.join(dbPath, COLLECTION_NAME);
    await fs.mkdir(colDir, { recursive: true });

    const walPath = getWalPath(colDir, COLLECTION_NAME);
    await initializeWal(walPath, colDir); // Создает пустой WAL

    // Записываем валидные записи
    await appendWalEntry(walPath, { op: 'INSERT', doc: { _id: 'doc1', name: 'Valid Doc 1', value: 10 } });
    await appendWalEntry(walPath, { op: 'INSERT', doc: { _id: 'doc2', name: 'Valid Doc 2', value: 20 } });
    // Записываем битую строку
    await fs.appendFile(walPath, 'this is not a valid json line that will be skipped\n', 'utf8');
    // Еще одна валидная запись после битой
    await appendWalEntry(walPath, { op: 'INSERT', doc: { _id: 'doc3', name: 'Valid Doc 3 After Corrupt', value: 30 } });
    // Запись на обновление
    await appendWalEntry(walPath, { op: 'UPDATE', id: 'doc1', data: { name: 'Updated Doc 1', value: 15 } });
    // Запись на удаление
    await appendWalEntry(walPath, { op: 'REMOVE', id: 'doc2' });


    // Инициализируем БД, она должна прочитать WAL
    // Передаем опцию recover, чтобы wal-manager не падал на ошибке, а пропускал битую строку
    const db = new WiseJSON(dbPath, { walReadOptions: { recover: true, strict: false } });
    await db.init(); // Этот init неявно вызовет col.init, если мы потом вызовем db.collection
    
    const col = await db.collection(COLLECTION_NAME);
    await col.initPromise; // Это вызовет чтение WAL с опциями из db.options

    // Ожидаем:
    // doc1 - вставлен и обновлен
    // doc2 - вставлен и удален
    // doc3 - вставлен
    // Итого 2 документа (doc1, doc3)
    const count = await col.count();
    assert.strictEqual(count, 2, 'Should recover 2 documents after WAL processing (doc1 updated, doc2 removed, doc3 inserted)');

    const doc1 = await col.getById('doc1');
    assert.ok(doc1, 'doc1 should be recovered');
    assert.strictEqual(doc1.name, 'Updated Doc 1', 'doc1 should be updated');
    assert.strictEqual(doc1.value, 15, 'doc1 value should be updated');

    const doc2 = await col.getById('doc2');
    assert.strictEqual(doc2, null, 'doc2 should be removed');

    const doc3 = await col.getById('doc3');
    assert.ok(doc3, 'doc3 (after corruption) should be recovered');
    assert.strictEqual(doc3.name, 'Valid Doc 3 After Corrupt', 'doc3 name check');


    // Проверим, что WAL был прочитан с опцией recover (должен быть warning в консоли)
    // Это сложнее проверить автоматически без мокинга console.warn,
    // но мы ожидаем правильное количество документов.

    await db.close();
    await cleanUpDbDirectory(dbPath);
    console.log('  --- Corrupted WAL Recovery Test PASSED ---');
}

async function testIndexEdgeCases() {
    console.log('  --- Running Index Edge Cases Test ---');
    const dbPath = path.join(DB_ROOT_PATH, 'index_edge');
    await cleanUpDbDirectory(dbPath);

    const db = new WiseJSON(dbPath);
    await db.init();
    const col = await db.collection(COLLECTION_NAME);
    await col.initPromise;

    // 1. Создание индекса
    await col.createIndex('email', { unique: false }); // Не уникальный для начала
    let indexes = await col.getIndexes();
    assert.strictEqual(indexes.length, 1, 'Index should be created');
    assert.strictEqual(indexes[0].fieldName, 'email', 'Correct index fieldName');
    assert.strictEqual(indexes[0].type, 'standard', 'Index type should be standard');

    // 2. Попытка создать существующий индекс (должна быть ошибка)
    let errorThrown = false;
    try {
        await col.createIndex('email'); // Попытка создать такой же
    } catch (e) {
        assert.ok(e.message.includes('already exists') || e.message.includes('уже существует'), 'Error for duplicate index definition');
        errorThrown = true;
    }
    assert.ok(errorThrown, 'Should throw error when creating an existing index definition');
    indexes = await col.getIndexes();
    assert.strictEqual(indexes.length, 1, 'Index count should remain 1 after failed creation');

    // 3. Удаление индекса
    await col.dropIndex('email');
    indexes = await col.getIndexes();
    assert.strictEqual(indexes.length, 0, 'Index should be dropped');

    // 4. Попытка удалить несуществующий индекс (не должно быть ошибки, просто ничего не делает)
    await col.dropIndex('non_existent_field');
    indexes = await col.getIndexes();
    assert.strictEqual(indexes.length, 0, 'Dropping non-existent index should not change index list');

    // 5. Создание уникального индекса
    await col.createIndex('username', { unique: true });
    indexes = await col.getIndexes();
    assert.strictEqual(indexes.length, 1, 'Unique index should be created');
    assert.strictEqual(indexes[0].fieldName, 'username', 'Correct unique index fieldName');
    assert.strictEqual(indexes[0].type, 'unique', 'Index type should be unique');

    await db.close();
    await cleanUpDbDirectory(dbPath);
    console.log('  --- Index Edge Cases Test PASSED ---');
}

async function testEmptyDbOperations() {
    console.log('  --- Running Empty DB Operations Test ---');
    const dbPath = path.join(DB_ROOT_PATH, 'empty_db_ops'); // Изменил имя, чтобы не конфликтовать с другими если cleanup не сработает
    await cleanUpDbDirectory(dbPath);

    const db = new WiseJSON(dbPath);
    await db.init(); // Важно, чтобы сама директория dbPath была создана, если ее нет

    // 1. getCollectionNames для пустой БД (dbPath существует, но в ней нет директорий коллекций)
    const names = await db.getCollectionNames();
    assert.deepStrictEqual(names, [], 'getCollectionNames on empty DB directory should return empty array');

    // 2. Попытка получить несуществующую коллекцию и выполнить операции
    // WiseJSON создаст директорию для 'non_existent_col' при первом обращении
    const col = await db.collection('non_existent_col');
    await col.initPromise;

    const colPath = path.join(dbPath, 'non_existent_col');
    const colDirExists = await fs.stat(colPath).then(stat => stat.isDirectory()).catch(() => false);
    assert.ok(colDirExists, 'Directory for new collection should be created');

    assert.strictEqual(await col.count(), 0, 'Count on new empty collection should be 0');
    const doc = await col.getById('any_id');
    assert.strictEqual(doc, null, 'getById on empty collection should return null');

    // 3. Создаем еще одну коллекцию, чтобы проверить getCollectionNames
    const col2 = await db.collection('another_col');
    await col2.initPromise; // Гарантируем создание
    await col2.insert({_id: 'test'}); // Добавим документ, чтобы коллекция не была пустой при проверке
    await col2.flushToDisk(); // Сохраним чекпоинт, чтобы директория точно была "заполнена"

    const updatedNames = (await db.getCollectionNames()).sort(); // Сортируем для надежного сравнения
    assert.deepStrictEqual(updatedNames, ['another_col', 'non_existent_col'].sort(), 'getCollectionNames should list newly created collections');

    await db.close();
    await cleanUpDbDirectory(dbPath);
    console.log('  --- Empty DB Operations Test PASSED ---');
}

async function testSegmentedCheckpointCleanup() {
    console.log('  --- Running Segmented Checkpoint Cleanup Test ---');
    const dbPath = path.join(DB_ROOT_PATH, 'checkpoint_cleanup_seg'); // Изменил имя
    await cleanUpDbDirectory(dbPath);

    const dbOptions = {
        maxSegmentSizeBytes: 50,  // Очень маленький размер сегмента (меньше одного документа)
        checkpointsToKeep: 2,
        checkpointIntervalMs: 5 * 60 * 1000, // Большой интервал, чекпоинты вручную
    };
    const db = new WiseJSON(dbPath, dbOptions);
    await db.init();
    const col = await db.collection(COLLECTION_NAME);
    await col.initPromise;

    // Вставляем данные
    for (let i = 0; i < 5; i++) { // Меньше документов, но они должны попасть в разные сегменты из-за размера
        await col.insert({ _id: `doc_seg_${i}`, text: `Document segment content part ${i} with enough text to exceed segment size potentially.` });
    }

    // Создаем несколько чекпоинтов вручную
    // Каждый flushToDisk создает чекпоинт и вызывает compactWal,
    // а close у коллекции также вызывает flushToDisk.
    // cleanupOldCheckpoints вызывается внутри flushToDisk неявно после сохранения нового чекпоинта.

    await col.flushToDisk(); // Checkpoint 1 (создан, cleanup еще нечего удалять или удалит 0)
    await sleep(20); // Разные timestamp
    await col.insert({ _id: 'extra_doc_cp2', text: 'Another doc for checkpoint 2' });
    await col.flushToDisk(); // Checkpoint 2 (создан, cleanup может удалить самый старый, если их > checkpointsToKeep)

    await sleep(20);
    await col.insert({ _id: 'extra_doc_cp3', text: 'Yet another doc for checkpoint 3' });
    await col.flushToDisk(); // Checkpoint 3 (создан, самый старый из предыдущих (если их было >2) должен удалиться)

    await sleep(20);
    await col.insert({ _id: 'extra_doc_cp4', text: 'Final doc for checkpoint 4' });
    await col.flushToDisk(); // Checkpoint 4 (создан, ...)

    const checkpointsDir = path.join(dbPath, COLLECTION_NAME, '_checkpoints');
    let files = [];
    try {
        files = await fs.readdir(checkpointsDir);
    } catch (e) {
        // Если директории нет, это тоже провал для этого теста
        assert.fail(`Checkpoints directory not found: ${checkpointsDir}`);
    }

    const metaFiles = files.filter(f => f.startsWith(`checkpoint_meta_${COLLECTION_NAME}_`) && f.endsWith('.json'));
    const dataFiles = files.filter(f => f.startsWith(`checkpoint_data_${COLLECTION_NAME}_`) && f.endsWith('.json'));

    assert.strictEqual(metaFiles.length, dbOptions.checkpointsToKeep, `Should keep ${dbOptions.checkpointsToKeep} meta checkpoint files. Found: ${metaFiles.join(', ')}`);

    const keptTimestamps = new Set(
        metaFiles.map(f => {
            const match = f.match(new RegExp(`^checkpoint_meta_${COLLECTION_NAME}_(.+)\\.json$`));
            return match ? match[1] : null;
        }).filter(Boolean)
    );
    assert.strictEqual(keptTimestamps.size, dbOptions.checkpointsToKeep, 'Number of unique timestamps in kept meta files should match checkpointsToKeep');

    for (const dataFile of dataFiles) {
        const match = dataFile.match(new RegExp(`^checkpoint_data_${COLLECTION_NAME}_(.+)_seg\\d+\\.json$`));
        const dataTimestamp = match ? match[1] : null;
        assert.ok(dataTimestamp, `Could not parse timestamp from data file: ${dataFile}`);
        assert.ok(keptTimestamps.has(dataTimestamp), `Data segment ${dataFile} (ts: ${dataTimestamp}) should belong to a kept checkpoint. Kept TS: ${Array.from(keptTimestamps).join(', ')}`);
    }

    // Проверяем, что есть хотя бы один data-сегмент для каждого meta-файла
    const dataFileTimestamps = new Set(
        dataFiles.map(f => {
            const match = f.match(new RegExp(`^checkpoint_data_${COLLECTION_NAME}_(.+)_seg\\d+\\.json$`));
            return match ? match[1] : null;
        }).filter(Boolean)
    );
    assert.deepStrictEqual(dataFileTimestamps, keptTimestamps, 'Timestamps of data segments should match timestamps of kept meta files.');
    assert.ok(dataFiles.length >= dbOptions.checkpointsToKeep, 'Should have at least as many data files as meta files kept');

    await db.close();
    await cleanUpDbDirectory(dbPath);
    console.log('  --- Segmented Checkpoint Cleanup Test PASSED ---');
}


async function main() {
    console.log('=== ADVANCED SCENARIOS DB TEST START ===');
    try {
        await fs.mkdir(DB_ROOT_PATH, { recursive: true });
    } catch (e) { /* может уже существовать, это ок */ }

    try {
        await testTtlEdgeCases();
        await testCorruptedWalRecovery();
        await testIndexEdgeCases();
        await testEmptyDbOperations();
        await testSegmentedCheckpointCleanup();

        console.log('=== ADVANCED SCENARIOS DB TEST PASSED SUCCESSFULLY ===');
    } catch (error) {
        console.error('\n🔥 ADVANCED SCENARIOS TEST FAILED:', error);
        // Не удаляем DB_ROOT_PATH если тесты упали, для отладки
        console.error(`\n❗ Test data was NOT removed for debugging: ${DB_ROOT_PATH}`);
        process.exit(1);
    } finally {
        // Финальная очистка всей корневой директории тестов, ТОЛЬКО ЕСЛИ ВСЕ ПРОШЛО УСПЕШНО
        // Если тесты упали, этот блок не выполнится из-за process.exit(1) в catch
        // Если нужно всегда чистить, можно убрать process.exit(1) и перенести cleanUpDbDirectory сюда.
        // Однако, для CI лучше оставлять артефакты при падении.
        if (process.exitCode !== 1) { // Проверяем, не было ли ошибки
             // await cleanUpDbDirectory(DB_ROOT_PATH);
             // console.log('[Test Main] Final cleanup of DB_ROOT_PATH skipped for now.');
        }
    }
}

// Запускаем main и обрабатываем возможные ошибки на самом верхнем уровне
main().catch(err => {
    console.error('\n🔥 UNHANDLED ERROR IN TEST RUNNER (main function level):', err);
    console.error(`\n❗ Test data was NOT removed for debugging: ${DB_ROOT_PATH}`);
    process.exit(1);
});