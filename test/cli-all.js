// test/cli-unified-all.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// 1. Определяем константы
const DB_PATH = path.resolve(__dirname, 'cli-unified-db');
const CLI_PATH = `node ${path.resolve(__dirname, '../cli/index.js')}`;
const TEST_COLLECTION = 'unified_users';
const DATA_FILE_PATH = path.join(__dirname, 'cliapi-import.json'); // Входные данные
const EXPORT_JSON_PATH = path.join(__dirname, 'cli-unified-export.json'); // Выходные данные

// 2. Вспомогательная функция для очистки
function cleanUp() {
    // Удаляем директорию БД
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
    // Удаляем файл экспорта
    if (fs.existsSync(EXPORT_JSON_PATH)) {
        fs.unlinkSync(EXPORT_JSON_PATH);
    }
    // *** ИСПРАВЛЕНИЕ: ДОБАВЛЯЕМ УДАЛЕНИЕ ФАЙЛА ИМПОРТА ***
    if (fs.existsSync(DATA_FILE_PATH)) {
        fs.unlinkSync(DATA_FILE_PATH);
    }
}

// 3. Главная вспомогательная функция для запуска CLI
function runCli(command, options = {}) {
    // ... (без изменений)
    const env = { ...process.env, WISE_JSON_PATH: DB_PATH, LOG_LEVEL: 'none' };
    const fullCommand = `${CLI_PATH} ${command}`;
    try {
        const stdout = execSync(fullCommand, { env, stdio: 'pipe' }).toString();
        if (options.shouldFail) {
            assert.fail(`Command "${command}" should have failed but it succeeded.`);
        }
        return stdout.trim();
    } catch (error) {
        if (!options.shouldFail) {
            const stderr = error.stderr ? error.stderr.toString() : '';
            console.error(`Command failed unexpectedly: ${fullCommand}\nStderr: ${stderr}`);
            throw error;
        }
        return error.stderr ? error.stderr.toString().trim() : '';
    }
}

async function main() {
    console.log('=== UNIFIED CLI ALL TEST START ===');
    // Вызываем очистку в самом начале на случай, если предыдущий запуск упал
    cleanUp();

    try {
        // --- Подготовка данных для тестов ---
        const testUsers = Array.from({ length: 10 }, (_, i) => ({
            _id: `user${i}`,
            name: `User ${i}`,
            age: 20 + i,
            city: i % 2 === 0 ? 'New York' : 'London',
            tags: [`tag${i}`]
        }));
        // Создаем временный файл с данными
        fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(testUsers));

        // --- Тест 1: Защита от записи ---
        console.log('  --- Testing write protection ---');
        runCli(`create-index ${TEST_COLLECTION} name`, { shouldFail: true });
        console.log('  --- Write protection PASSED ---');

        // --- Тест 2: Базовые операции записи и чтения ---
        console.log('  --- Testing basic write/read operations ---');
        runCli(`import-collection ${TEST_COLLECTION} ${DATA_FILE_PATH} --allow-write`);
        
        const collectionsOutput = runCli(`list-collections`);
        assert.ok(collectionsOutput.includes(TEST_COLLECTION), 'list-collections should show the new collection');
        
        const docsOutput = runCli(`show-collection ${TEST_COLLECTION}`);
        const docs = JSON.parse(docsOutput);
        assert.strictEqual(docs.length, 10, 'show-collection should return 10 documents');
        
        const singleDoc = JSON.parse(runCli(`get-document ${TEST_COLLECTION} user3`));
        assert.strictEqual(singleDoc.name, 'User 3', 'get-document should retrieve the correct document');
        console.log('  --- Basic write/read operations PASSED ---');

        // --- Тест 3: Фильтрация и опции ---
        console.log('  --- Testing filtering and options ---');
        
        const filterObject = { city: 'New York' };
        let filterArgument;

        if (os.platform() === 'win32') {
            const escapedJson = JSON.stringify(filterObject).replace(/"/g, '\\"');
            filterArgument = `"${escapedJson}"`;
        } else {
            filterArgument = `'${JSON.stringify(filterObject)}'`;
        }
        
        const filteredDocsOutput = runCli(`show-collection ${TEST_COLLECTION} --filter=${filterArgument}`);
        
        const filteredDocs = JSON.parse(filteredDocsOutput);
        assert.strictEqual(filteredDocs.length, 5, 'Filtering by city should return 5 documents');
        assert.ok(filteredDocs.every(d => d.city === 'New York'), 'All filtered docs should be from New York');

        const limitedOutput = runCli(`show-collection ${TEST_COLLECTION} --limit=3`);
        assert.strictEqual(JSON.parse(limitedOutput).length, 3, 'Limit option should work');
        console.log('  --- Filtering and options PASSED ---');

        // --- Тест 4: Управление индексами ---
        console.log('  --- Testing index management ---');
        runCli(`create-index ${TEST_COLLECTION} name --unique --allow-write`);
        const indexes = JSON.parse(runCli(`list-indexes ${TEST_COLLECTION}`));
        assert.ok(indexes.some(idx => idx.fieldName === 'name' && idx.type === 'unique'), 'Index should be created');
        
        runCli(`drop-index ${TEST_COLLECTION} name --allow-write`);
        const indexesAfterDrop = JSON.parse(runCli(`list-indexes ${TEST_COLLECTION}`));
        assert.strictEqual(indexesAfterDrop.length, 0, 'Index should be dropped');
        console.log('  --- Index management PASSED ---');

        // --- Тест 5: Опасные операции и флаг --force ---
        console.log('  --- Testing dangerous operations ---');
        runCli(`collection-drop ${TEST_COLLECTION} --allow-write`, { shouldFail: true });

        runCli(`collection-drop ${TEST_COLLECTION} --allow-write --force`);
        const collectionsAfterDrop = runCli('list-collections');
        assert.ok(!collectionsAfterDrop.includes(TEST_COLLECTION), 'Collection should be dropped with --force');
        console.log('  --- Dangerous operations PASSED ---');
        
    } finally {
        // Гарантированная очистка после выполнения всех тестов, даже если они упали
        cleanUp();
    }

    console.log('=== UNIFIED CLI ALL TEST PASSED SUCCESSFULLY ===');
}

main().catch(err => {
    console.error('\n🔥 UNIFIED CLI TEST FAILED:', err);
    // Гарантированная очистка в случае глобальной ошибки
    cleanUp();
    process.exit(1);
});