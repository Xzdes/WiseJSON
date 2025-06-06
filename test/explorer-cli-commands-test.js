#!/usr/bin/env node

/**
 * test/explorer-cli-commands-test.js
 * Тестирование новых CLI-команд Data Explorer
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = `node explorer/cli.js`;
const DB_PATH = path.resolve(process.cwd(), 'wise-json-db-data');
const TEST_COLLECTION = 'testcollection_cli';

function cleanUp() {
    fs.rmSync(DB_PATH, { recursive: true, force: true });
    fs.rmSync('test-export.json', { force: true });
    fs.rmSync('test-export.csv', { force: true });
    fs.rmSync('test-import.json', { force: true });
}

function run(command) {
    console.log(`\n> ${command}`);
    execSync(command, { stdio: 'inherit' });
}

async function main() {
    console.log('=== WiseJSON Explorer CLI Commands Test Start ===');
    cleanUp();

    // 1. Создаём тестовую коллекцию
    fs.mkdirSync(DB_PATH, { recursive: true });
    fs.writeFileSync(
        'test-import.json',
        JSON.stringify([
            { name: 'Alice', age: 25 },
            { name: 'Bob', age: 30 }
        ], null, 2)
    );

    // 2. Импортируем коллекцию
    run(`${CLI} import-collection ${TEST_COLLECTION} test-import.json --mode replace --allow-write`);

    // 3. Экспортируем коллекцию в JSON
    run(`${CLI} export-collection ${TEST_COLLECTION} test-export.json`);

    // 4. Экспортируем коллекцию в CSV
    run(`${CLI} export-collection ${TEST_COLLECTION} test-export.csv --output csv`);

    // 5. Проверяем создание индекса
    run(`${CLI} create-index ${TEST_COLLECTION} name --allow-write`);
    run(`${CLI} list-indexes ${TEST_COLLECTION}`);

    // 6. Удаляем индекс
    run(`${CLI} drop-index ${TEST_COLLECTION} name --allow-write`);
    run(`${CLI} list-indexes ${TEST_COLLECTION}`);

    console.log('=== WiseJSON Explorer CLI Commands Test End ===');
    cleanUp();
}

main();
