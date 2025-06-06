#!/usr/bin/env node

/**
 * test/explorer-cli-errors-test.js
 * Тестирование ошибок CLI (неправильный JSON, отсутствующая коллекция)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = `node explorer/cli.js`;
const TEST_COLLECTION = 'nonexistent_collection';
const EXISTING_COLLECTION = 'testcollection_flags';
const TEST_FILE = 'invalid-filter.json';
const DATA_FILE = 'test-flags.json';

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
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

    execSync(`${CLI} import-collection ${EXISTING_COLLECTION} ${DATA_FILE} --mode replace --allow-write`, {
        stdio: 'inherit'
    });
}

function prepareInvalidFilterFile() {
    fs.writeFileSync(TEST_FILE, '{invalidJson: true'); // некорректный JSON
}

function cleanUp() {
    if (fs.existsSync(TEST_FILE)) {
        fs.unlinkSync(TEST_FILE);
    }
    if (fs.existsSync(DATA_FILE)) {
        fs.unlinkSync(DATA_FILE);
    }
}

async function main() {
    console.log('=== WiseJSON Explorer CLI Errors Test Start ===');
    cleanUp();
    prepareInvalidFilterFile();
    prepareTestData();

    try {
        // 1. Ошибка: отсутствующая коллекция
        run(`${CLI} show-collection ${TEST_COLLECTION}`);

        // 2. Ошибка: некорректный JSON фильтр
        run(`${CLI} show-collection ${EXISTING_COLLECTION} --filter "{invalidJson:true}"`);

        console.log('=== WiseJSON Explorer CLI Errors Test End ===');
    } catch (err) {
        console.error('Test failed:', err.message);
        process.exit(1);
    } finally {
        cleanUp();
    }
}

main();
