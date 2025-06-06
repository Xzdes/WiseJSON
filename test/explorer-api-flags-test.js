#!/usr/bin/env node

/**
 * test/explorer-api-flags-test.js
 * Тестирование API флагов limit, offset, sort, filter
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn, execSync } = require('child_process');

const BASE_URL = 'http://127.0.0.1:3000';
const TEST_COLLECTION = 'testcollection_flags';
const TEST_FILE = 'test-flags.json';
let serverProcess;

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

function startServer() {
    return new Promise((resolve, reject) => {
        serverProcess = spawn('node', ['explorer/server.js'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        serverProcess.stdout.on('data', (data) => {
            const line = data.toString();
            if (line.includes('WiseJSON Data Explorer running')) {
                resolve();
            }
        });

        serverProcess.stderr.on('data', (data) => {
            console.error('Server error:', data.toString());
        });

        serverProcess.on('exit', (code) => {
            console.log(`Server exited with code ${code}`);
        });
    });
}

function stopServer() {
    if (serverProcess) {
        serverProcess.kill();
    }
}

function prepareTestData() {
    const data = [];
    for (let i = 0; i < 10; i++) {
        data.push({ name: `User${i}`, age: 20 + i });
    }
    fs.writeFileSync(TEST_FILE, JSON.stringify(data, null, 2));

    // Импортируем данные через CLI
    execSync(`node explorer/cli.js import-collection ${TEST_COLLECTION} ${TEST_FILE} --mode replace --allow-write`, {
        stdio: 'inherit'
    });
}

function cleanUp() {
    if (fs.existsSync(TEST_FILE)) {
        fs.unlinkSync(TEST_FILE);
    }
}

async function main() {
    console.log('=== WiseJSON Explorer API Flags Test Start ===');
    cleanUp();
    prepareTestData();

    await startServer();

    try {
        // 1. /api/collections
        const collections = await fetchJson(`${BASE_URL}/api/collections`);
        assert(Array.isArray(collections), 'Expected array of collections');
        assert(collections.find(c => c.name === TEST_COLLECTION), `Expected collection: ${TEST_COLLECTION}`);

        // 2. /api/collections/:name?limit=3
        const docsLimited = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?limit=3`);
        assert(docsLimited.length === 3, 'Expected 3 documents');

        // 3. /api/collections/:name?offset=5&limit=3
        const docsOffset = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?offset=5&limit=3`);
        assert(docsOffset.length === 3, 'Expected 3 documents with offset');

        // 4. /api/collections/:name?sort=age&order=desc
        const docsSorted = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?sort=age&order=desc`);
        assert(docsSorted[0].age >= docsSorted[1].age, 'Expected descending order');

        // 5. /api/collections/:name?filter_name=User5
        const docsFiltered = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?filter_name=User5`);
        assert(docsFiltered.length === 1, 'Expected 1 document with name=User5');
        assert(docsFiltered[0].name === 'User5', 'Expected document with name=User5');

        console.log('=== WiseJSON Explorer API Flags Test End ===');
    } catch (err) {
        console.error('Test failed:', err.message);
        process.exit(1);
    } finally {
        stopServer();
        cleanUp();
    }
}

main();
