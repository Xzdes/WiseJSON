#!/usr/bin/env node

/**
 * test/explorer-cli-flags-test.js
 * Тестирование флагов --limit, --offset, --sort, --filter
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = `node explorer/cli.js`;
const DB_PATH = path.resolve(process.cwd(), 'wise-json-db-data');
const TEST_COLLECTION = 'testcollection_flags';

function cleanUp() {
    fs.rmSync(DB_PATH, { recursive: true, force: true });
    fs.rmSync('test-flags.json', { force: true });
}

function run(command) {
    console.log(`\n> ${command}`);
    execSync(command, { stdio: 'inherit' });
}

async function main() {
    console.log('=== WiseJSON Explorer CLI Flags Test Start ===');
    cleanUp();

    // 1. Создаём тестовую коллекцию
    fs.mkdirSync(DB_PATH, { recursive: true });
    const data = [];
    for (let i = 0; i < 10; i++) {
        data.push({ name: `User${i}`, age: 20 + i });
    }
    fs.writeFileSync('test-flags.json', JSON.stringify(data, null, 2));

    // 2. Импортируем коллекцию
    run(`${CLI} import-collection ${TEST_COLLECTION} test-flags.json --mode replace --allow-write`);

    // 3. Тестируем --limit
    run(`${CLI} show-collection ${TEST_COLLECTION} --limit 3`);

    // 4. Тестируем --offset
    run(`${CLI} show-collection ${TEST_COLLECTION} --offset 5 --limit 3`);

    // 5. Тестируем --sort age
    run(`${CLI} show-collection ${TEST_COLLECTION} --sort age`);

    // 6. Тестируем --sort age --order desc
    run(`${CLI} show-collection ${TEST_COLLECTION} --sort age --order desc`);

    // 7. Тестируем --filter
    run(`${CLI} show-collection ${TEST_COLLECTION} --filter "{\\"name\\":\\"User5\\"}"`);

    console.log('=== WiseJSON Explorer CLI Flags Test End ===');
    cleanUp();
}

main();
