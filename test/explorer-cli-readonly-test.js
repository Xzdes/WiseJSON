#!/usr/bin/env node

/**
 * test/explorer-cli-readonly-test.js
 * Тестирование ReadOnly режима (запрет на импорт)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = `node explorer/cli.js`;
const TEST_COLLECTION = 'testcollection_flags';
const TEST_FILE = 'test-flags.json';

function run(command) {
    console.log(`\n> ${command}`);
    try {
        execSync(command, { stdio: 'pipe' });
        console.error('❌ Expected error, but command succeeded');
        process.exit(1);
    } catch (err) {
        console.log(`✅ Caught expected error: ${err.message}`);
    }
}

function prepareTestData() {
    const data = [];
    for (let i = 0; i < 10; i++) {
        data.push({ name: `User${i}`, age: 20 + i });
    }
    fs.writeFileSync(TEST_FILE, JSON.stringify(data, null, 2));
}

function cleanUp() {
    if (fs.existsSync(TEST_FILE)) {
        fs.unlinkSync(TEST_FILE);
    }
}

async function main() {
    console.log('=== WiseJSON Explorer CLI ReadOnly Test Start ===');
    cleanUp();
    prepareTestData();

    try {
        // Проверяем, что в режиме ReadOnly импорт запрещён
        run(`${CLI} import-collection ${TEST_COLLECTION} ${TEST_FILE} --mode replace`);

        console.log('=== WiseJSON Explorer CLI ReadOnly Test End ===');
    } catch (err) {
        console.error('Test failed:', err.message);
        process.exit(1);
    } finally {
        cleanUp();
    }
}

main();
