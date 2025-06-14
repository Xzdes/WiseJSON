// test/cli-management-all.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const DB_PATH = path.resolve(__dirname, 'cli-management-db');
const CLI_PATH = `node ${path.resolve(__dirname, '../explorer/cli.js')}`;
const TEST_COLLECTION = 'mgmt_test_users';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
}

function runCli(command, options = {}) {
    const env = { ...process.env, WISE_JSON_PATH: DB_PATH, LOG_LEVEL: 'none' };
    const fullCommand = `${CLI_PATH} ${command}`;
    try {
        const stdout = execSync(fullCommand, { env, stdio: 'pipe' }).toString();
        if (options.shouldFail) assert.fail(`Command "${command}" should have failed.`);
        return stdout.trim();
    } catch (error) {
        if (!options.shouldFail) {
            const stderr = error.stderr ? error.stderr.toString() : '';
            console.error(`Command failed unexpectedly: ${fullCommand}\n${stderr}`);
            throw error;
        }
        return error.stderr ? error.stderr.toString().trim() : '';
    }
}

function runCliAndGetJson(command, options = {}) {
    const output = runCli(command, options);
    try {
        return JSON.parse(output);
    } catch (e) {
        assert.fail(`Failed to parse JSON from command output. Command: "${command}", Output: "${output}"`);
    }
}

async function main() {
    console.log('=== CLI MANAGEMENT ALL TEST START ===');
    cleanUp();

    // 1. Проверка защиты от записи.
    console.log('  --- Running write-protection tests ---');
    runCli(`doc-insert ${TEST_COLLECTION} '{"name":"test"}'`, { shouldFail: true });
    runCli(`create-index ${TEST_COLLECTION} name`, { shouldFail: true });
    runCli(`collection-drop ${TEST_COLLECTION}`, { shouldFail: true });
    console.log('  --- Write-protection tests PASSED ---');

    // 2. Создание индекса (это также создаст коллекцию)
    console.log('  --- Running create-index and drop-index tests ---');
    runCli(`create-index ${TEST_COLLECTION} name --unique --allow-write`);
    
    let indexes = runCliAndGetJson(`list-indexes ${TEST_COLLECTION}`);
    assert.ok(indexes.some(idx => idx.fieldName === 'name' && idx.type === 'unique'), 'create-index: Index should be created.');
    
    runCli(`drop-index ${TEST_COLLECTION} name --allow-write`);
    
    indexes = runCliAndGetJson(`list-indexes ${TEST_COLLECTION}`);
    assert.strictEqual(indexes.length, 0, 'drop-index: Index should be dropped.');
    console.log('  --- create-index and drop-index tests PASSED ---');

    // 3. Вставка и удаление документа
    console.log('  --- Running doc-insert and doc-remove tests ---');
    const docToInsert = { "_id": "doc123", "name": "Cli User", "value": 100 };
    const jsonArg = JSON.stringify(JSON.stringify(docToInsert));
    
    const insertedDoc = runCliAndGetJson(`doc-insert ${TEST_COLLECTION} ${jsonArg} --allow-write`);
    assert.strictEqual(insertedDoc._id, "doc123", "doc-insert: Inserted doc should have correct ID.");
    
    const foundDoc = runCliAndGetJson(`get-document ${TEST_COLLECTION} doc123`);
    assert.strictEqual(foundDoc.name, "Cli User", "get-document: Document should be retrievable.");

    runCli(`doc-remove ${TEST_COLLECTION} doc123 --allow-write`);
    
    runCli(`get-document ${TEST_COLLECTION} doc123`, { shouldFail: true });
    console.log('  --- doc-insert and doc-remove tests PASSED ---');

    // 4. Удаление коллекции
    console.log('  --- Running collection-drop test ---');
    runCli(`collection-drop ${TEST_COLLECTION} --allow-write --force`);
    
    const collectionPath = path.join(DB_PATH, TEST_COLLECTION);
    assert.ok(!fs.existsSync(collectionPath), 'collection-drop: Collection directory should be removed.');
    console.log('  --- collection-drop test PASSED ---');

    // 5. Проверка вывода ошибок в формате JSON
    console.log('  --- Running JSON error output test ---');
    const errorOutput = runCli(`get-document non_existent_collection some_id --json-errors`, { shouldFail: true });
    const errorJson = JSON.parse(errorOutput);
    assert.strictEqual(errorJson.error, true, 'JSON error: "error" key should be true.');
    assert.ok(errorJson.message.includes('non_existent_collection'), 'JSON error: message should contain collection name.');
    console.log('  --- JSON error output test PASSED ---');

    cleanUp();
    console.log('=== CLI MANAGEMENT ALL TEST PASSED SUCCESSFULLY ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    console.error(`\n❗ Тестовая директория не была удалена для отладки: ${DB_PATH}`);
    process.exit(1);
});