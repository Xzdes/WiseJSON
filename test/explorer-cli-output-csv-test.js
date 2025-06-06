#!/usr/bin/env node

/**
 * test/explorer-cli-output-csv-test.js
 * Тестирование флага --output csv для экспорта коллекции
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = `node explorer/cli.js`;
const DB_PATH = path.resolve(process.cwd(), 'wise-json-db-data');
const TEST_COLLECTION = 'testcollection_flags';
const TEST_FILE = 'test-flags.json';
const EXPORT_FILE = 'test-export.csv';

function prepareTestData() {
    const data = [];
    for (let i = 0; i < 10; i++) {
        data.push({ name: `User${i}`, age: 20 + i });
    }
    fs.writeFileSync(TEST_FILE, JSON.stringify(data, null, 2));

    execSync(`${CLI} import-collection ${TEST_COLLECTION} ${TEST_FILE} --mode replace --allow-write`, {
        stdio: 'inherit'
    });
}

function cleanUp() {
    if (fs.existsSync(TEST_FILE)) {
        fs.unlinkSync(TEST_FILE);
    }
    if (fs.existsSync(EXPORT_FILE)) {
        fs.unlinkSync(EXPORT_FILE);
    }
}

function run(command) {
    console.log(`\n> ${command}`);
    execSync(command, { stdio: 'inherit' });
}

async function main() {
    console.log('=== WiseJSON Explorer CLI Output CSV Test Start ===');
    cleanUp();
    prepareTestData();

    try {
        // Экспортируем коллекцию в CSV
        run(`${CLI} export-collection ${TEST_COLLECTION} ${EXPORT_FILE} --output csv`);

        // Проверяем, что файл существует
        if (!fs.existsSync(EXPORT_FILE)) {
            throw new Error('CSV file was not created');
        }

        // Проверяем, что файл не пустой
        const content = fs.readFileSync(EXPORT_FILE, 'utf-8');
        if (content.trim().length === 0) {
            throw new Error('CSV file is empty');
        }

        console.log('CSV file exported and verified.');
        console.log('=== WiseJSON Explorer CLI Output CSV Test End ===');
    } catch (err) {
        console.error('Test failed:', err.message);
        process.exit(1);
    } finally {
        cleanUp();
    }
}

main();
