// test/cli-and-api-all.js

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const DB_PATH = path.resolve(__dirname, 'cli-and-api-db');
const CLI_PATH = `node ${path.resolve(__dirname, '../explorer/cli.js')}`;
const SERVER_PATH = path.resolve(__dirname, '../explorer/server.js');
const BASE_URL = 'http://127.0.0.1:3101';
const TEST_COLLECTION = 'cliapi_users';
const DATA_FILE = path.join(__dirname, 'cliapi-import.json');
const EXPORT_JSON = path.join(__dirname, 'cliapi-export.json');
const EXPORT_CSV = path.join(__dirname, 'cliapi-export.csv');
const AUTH_USER = 'apitest';
const AUTH_PASS = 'secret';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { recursive: true, force: true });
    [DATA_FILE, EXPORT_JSON, EXPORT_CSV].forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    });
}

function runCli(command, opts = {}) {
    const env = { ...process.env, WISE_JSON_PATH: DB_PATH, LOG_LEVEL: 'none' };
    const fullCommand = `${CLI_PATH} ${command}`;
    try {
        const stdout = execSync(fullCommand, { env, stdio: 'pipe' }).toString();
        if (opts.shouldFail) assert.fail(`Command "${command}" should have failed.`);
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

function fetchJson(url, { auth } = {}) {
    return new Promise((resolve, reject) => {
        const opts = { headers: {} };
        if (auth) {
            opts.headers['Authorization'] = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64')}`;
        }
        http.get(url, opts, res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                if (res.statusCode >= 400) {
                   return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function waitServerStart() {
    for (let i = 0; i < 30; i++) {
        try {
            await fetchJson(`${BASE_URL}/api/collections`, { auth: true });
            return;
        } catch (e) { await new Promise(r => setTimeout(r, 200)); }
    }
    throw new Error('Server did not start in time.');
}

async function main() {
    console.log('=== CLI AND API ALL TEST START ===');
    cleanUp();

    // --- CLI PART ---
    console.log('  --- Running CLI setup ---');
    const testUsers = Array.from({ length: 30 }, (_, i) => ({ name: `User${i}`, age: 20 + i, group: i % 3 }));
    fs.writeFileSync(DATA_FILE, JSON.stringify(testUsers, null, 2));

    // Используем CLI для импорта и экспорта
    runCli(`import-collection ${TEST_COLLECTION} ${DATA_FILE} --mode replace --allow-write`);
    runCli(`export-collection ${TEST_COLLECTION} ${EXPORT_JSON} --allow-write`);
    runCli(`export-collection ${TEST_COLLECTION} ${EXPORT_CSV} --output csv --allow-write`);

    // Проверяем, что файлы созданы
    assert(fs.existsSync(EXPORT_JSON), 'JSON export file should be created');
    assert(fs.existsSync(EXPORT_CSV), 'CSV export file should be created');
    console.log('  --- CLI setup PASSED ---');


    // --- API PART ---
    console.log('  --- Running API server tests ---');
    const serverProc = spawn('node', [SERVER_PATH], {
        stdio: 'pipe',
        env: {
            ...process.env,
            WISE_JSON_PATH: DB_PATH,
            PORT: '3101',
            LOG_LEVEL: 'none',
            WISEJSON_AUTH_USER: AUTH_USER,
            WISEJSON_AUTH_PASS: AUTH_PASS,
        }
    });

    serverProc.stderr.on('data', (data) => console.error(`Server stderr: ${data}`));

    let serverError = null;
    serverProc.on('error', (err) => { serverError = err; });

    try {
        await waitServerStart();

        const collections = await fetchJson(`${BASE_URL}/api/collections`, { auth: true });
        assert(collections.data.some(c => c.name === TEST_COLLECTION), 'API: test collection should exist');

        const docs = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?limit=5`, { auth: true });
        assert.strictEqual(docs.data.length, 5, 'API: limit should work');
        
        const byName = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?filter_name=User5`, { auth: true });
        assert.ok(byName.data.length === 1 && byName.data[0].name === 'User5', 'API: filter_name should work');
        
        const byGt = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?filter_age__gt=45`, { auth: true });
        assert.ok(byGt.data.every(u => u.age > 45), 'API: filter_age__gt should work');
        
        // Проверка авторизации: запрос без auth должен упасть
        await assert.rejects(
            fetchJson(`${BASE_URL}/api/collections`),
            /HTTP 401/,
            'API: Request without auth should be rejected with 401'
        );

    } finally {
        serverProc.kill();
        if (serverError) throw serverError;
    }
    console.log('  --- API server tests PASSED ---');


    cleanUp();
    console.log('=== CLI AND API ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    if (err.stack) console.error(err.stack);
    console.error(`\n❗ Директория/файлы не были удалены для отладки: ${DB_PATH}`);
    process.exit(1);
});