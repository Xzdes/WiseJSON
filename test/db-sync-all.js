// test/db-sync-all.js

const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const assert = require('assert');

const WiseJSON = require('../wise-json/index.js');
const { apiClient: ApiClient } = require('../index.js');

const DB_PATH = path.resolve(__dirname, 'db-sync-all-data');
const COLLECTION_NAME = 'sync_test_collection';
const SERVER_PORT = 13337;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// --- Улучшенный Мок-сервер ---
let mockServer;
const serverState = {
    opsLog: [],
    receivedBatchIds: new Set(),
    get server_lsn() { return this.opsLog.length; },
    rejectNextPush: false,
};

function startMockServer() {
    serverState.opsLog = [];
    serverState.receivedBatchIds.clear();
    serverState.rejectNextPush = false;

    mockServer = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');

            if (req.method === 'GET' && url.pathname === '/sync/health') {
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'ok', lsn: serverState.server_lsn }));
            } else if (req.method === 'GET' && url.pathname === '/sync/snapshot') {
                res.writeHead(200);
                res.end(JSON.stringify({
                    server_lsn: serverState.server_lsn,
                    documents: serverState.opsLog.map(op => op.doc || op.data).filter(Boolean),
                }));
            } else if (req.method === 'GET' && url.pathname === '/sync/pull') {
                const sinceLsn = parseInt(url.searchParams.get('since_lsn') || '0', 10);
                const ops = serverState.opsLog.slice(sinceLsn);
                res.writeHead(200);
                res.end(JSON.stringify({ server_lsn: serverState.server_lsn, ops }));
            } else if (req.method === 'POST' && url.pathname === '/sync/push') {
                if (serverState.rejectNextPush) {
                    serverState.rejectNextPush = false;
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: "Internal Server Error From Mock" }));
                    return;
                }
                try {
                    const payload = JSON.parse(body);
                    if (serverState.receivedBatchIds.has(payload.batchId)) {
                        res.writeHead(200);
                        res.end(JSON.stringify({ status: 'duplicate_ignored', server_lsn: serverState.server_lsn }));
                        return;
                    }
                    serverState.receivedBatchIds.add(payload.batchId);
                    const ops = Array.isArray(payload.ops) ? payload.ops : [];
                    serverState.opsLog.push(...ops);
                    res.writeHead(200);
                    res.end(JSON.stringify({ status: 'ok', server_lsn: serverState.server_lsn }));
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Bad request' }));
                }
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: `Not Found: ${req.method} ${url.pathname}` }));
            }
        });
    });

    return new Promise(resolve => {
        mockServer.listen(SERVER_PORT, () => {
            console.log(`  [MockServer] Запущен на порту ${SERVER_PORT}`);
            resolve();
        });
    });
}

function stopMockServer() {
    return new Promise(resolve => {
        if (mockServer && mockServer.listening) mockServer.close(resolve);
        else resolve();
    });
}

async function cleanUp() {
    try {
        if (await fs.stat(DB_PATH).catch(() => false)) {
            await fs.rm(DB_PATH, { recursive: true, force: true });
        }
    } catch (err) {
        console.warn(`[Cleanup Warning] Could not remove test directory ${DB_PATH}:`, err.message);
    }
}

const sleep = ms => new Promise(res => setTimeout(res, ms));


// --- Основной тест ---
async function main() {
    console.log('=== DB SYNC ALL TEST START ===');
    await cleanUp();
    await startMockServer();
    let db;

    try {
        db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(COLLECTION_NAME);
        await col.initPromise;

        const testApiClient = new ApiClient(SERVER_URL, 'test-key');
        
        col.enableSync({
            apiClient: testApiClient,
            url: SERVER_URL,
            apiKey: 'test-key',
            autoStartLoop: false
        });

        // --- Тест 1: Initial Sync и PUSH ---
        console.log('  --- Тест 1: Initial Sync и PUSH ---');
        await col.triggerSync(); // Initial Sync
        
        await col.insert({ _id: 'doc1', name: 'Alice' });
        await col.triggerSync(); // Push

        assert.strictEqual(serverState.opsLog.length, 1, 'Тест 1.1: Сервер должен получить 1 операцию');
        assert.strictEqual(serverState.opsLog[0].doc.name, 'Alice', 'Тест 1.2: Данные документа корректны');
        const lastBatchId = Array.from(serverState.receivedBatchIds).pop();
        console.log('  --- Тест 1 PASSED ---');

        // --- Тест 2: PULL ---
        console.log('  --- Тест 2: PULL ---');
        serverState.opsLog.push({ op: 'INSERT', doc: { _id: 'doc2', name: 'Bob', updatedAt: new Date().toISOString() }, ts: new Date().toISOString() });
        await col.triggerSync();
        const doc2 = await col.getById('doc2');
        assert.ok(doc2, 'Тест 2.1: doc2 должен быть создан с сервера');
        console.log('  --- Тест 2 PASSED ---');
        
        // --- Тест 3: Idempotent PUSH ---
        console.log('  --- Тест 3: Idempotent PUSH ---');
        assert.ok(serverState.receivedBatchIds.has(lastBatchId), 'Тест 3.1: Сервер должен помнить ID первого батча');
        const currentLogLength = serverState.opsLog.length;
        await testApiClient.post('/sync/push', { batchId: lastBatchId, ops: [{ op: 'INSERT', doc: { _id: 'doc1', name: 'Alice' } }] });
        assert.strictEqual(serverState.opsLog.length, currentLogLength, 'Тест 3.2: Сервер не должен применять дублирующийся батч');
        console.log('  --- Тест 3 PASSED ---');

        // --- Тест 4: Обработка ошибок PUSH и восстановление ---
        console.log('  --- Тест 4: PUSH Error Handling ---');
        serverState.rejectNextPush = true;
        await col.insert({ _id: 'doc3', name: 'Charlie' });
        
        await col.triggerSync().catch(() => {});
        
        assert.strictEqual(serverState.opsLog.some(op => op.doc?._id === 'doc3'), false, 'Тест 4.1: doc3 не должен попасть на сервер после ошибки');
        
        await col.triggerSync();
        assert.strictEqual(serverState.opsLog.some(op => op.doc?._id === 'doc3'), true, 'Тест 4.2: doc3 должен быть отправлен после восстановления');
        console.log('  --- Тест 4 PASSED ---');

        // --- Тест 5: Quarantine ---
        console.log('  --- Тест 5: Quarantine ---');
        const quarantineFile = col.quarantinePath;
        if (await fs.stat(quarantineFile).catch(()=>false)) await fs.unlink(quarantineFile);
        
        // --- ИЗМЕНЕНИЕ ЗДЕСЬ ---
        // Создаем операцию, которая гарантированно вызовет ошибку внутри _applyWalEntryToMemory,
        // но которую не отфильтрует наша новая логика в _applyRemoteOperation.
        // Операция INSERT без поля `doc` вызовет ошибку.
        serverState.opsLog.push({ op: 'INSERT', id: 'malformed-op-for-quarantine' });
        // --- КОНЕЦ ИЗМЕНЕНИЯ ---

        await col.triggerSync();
        
        await sleep(50); // Даем время на асинхронную запись в файл карантина

        const quarantineExists = await fs.stat(quarantineFile).catch(() => false);
        assert.ok(quarantineExists, 'Тест 5.1: Файл карантина должен быть создан');

        if (quarantineExists) {
            const quarantineContent = await fs.readFile(quarantineFile, 'utf-8').catch(() => '');
            assert.ok(quarantineContent.includes('malformed-op-for-quarantine'), 'Тест 5.2: Файл карантина должен содержать битую операцию');
            await fs.unlink(quarantineFile).catch(() => {});
        }
        console.log('  --- Тест 5 PASSED ---');

    } finally {
        if (db) await db.close();
        await stopMockServer();
        await cleanUp();
    }
    console.log('=== DB SYNC ALL TEST PASSED SUCCESSFULLY ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    if (err.stack) console.error(err.stack);
    const stopPromise = stopMockServer() || Promise.resolve();
    stopPromise.finally(() => process.exit(1));
});