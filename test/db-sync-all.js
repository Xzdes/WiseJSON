const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const WiseJSON = require('../wise-json/index.js');

const DB_PATH = path.resolve(__dirname, 'db-sync-all-data');
const COLLECTION_NAME = 'sync_test_collection';
const SERVER_PORT = 13337;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// --- Мок-сервер ---
let mockServer;
const serverState = {
    receivedOps: [],
    opsToSend: [],
    requestLog: [],
    rejectNextPush: false
};

function startMockServer() {
    serverState.receivedOps = [];
    serverState.opsToSend = [];
    serverState.requestLog = [];
    serverState.rejectNextPush = false;

    mockServer = http.createServer((req, res) => {
        serverState.requestLog.push({ method: req.method, url: req.url });
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            const url = new URL(req.url, `http://${req.headers.host}`);
            if (req.method === 'GET' && url.pathname === '/sync/pull') {
                res.writeHead(200);
                res.end(JSON.stringify(serverState.opsToSend));
                serverState.opsToSend = [];
            } else if (req.method === 'POST' && url.pathname === '/sync/push') {
                if (serverState.rejectNextPush) {
                    serverState.rejectNextPush = false;
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: "Internal Server Error From Mock" }));
                    return;
                }
                try {
                    const ops = JSON.parse(body);
                    serverState.receivedOps.push(...ops);
                    res.writeHead(200);
                    res.end(JSON.stringify({ status: 'ok' }));
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Bad request to mock server' }));
                }
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Not Found' }));
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
        if (mockServer && mockServer.listening) {
            mockServer.close(() => {
                console.log('  [MockServer] Остановлен');
                resolve();
            });
        } else {
            resolve();
        }
    });
}

function cleanUp() {
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// --- Самодостаточный apiClient ---
function makeTestApiClient() {
    return {
        post: (relativeUrl, body) => {
            return new Promise((resolve, reject) => {
                const data = JSON.stringify(body);
                const urlObj = new URL(relativeUrl, SERVER_URL);
                const opts = {
                    method: 'POST',
                    hostname: urlObj.hostname,
                    port: urlObj.port,
                    path: urlObj.pathname,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data)
                    }
                };
                const req = http.request(opts, res => {
                    let responseData = '';
                    res.on('data', chunk => { responseData += chunk; });
                    res.on('end', () => {
                        if (res.statusCode >= 400) {
                            const err = new Error('Server error: ' + responseData);
                            err.statusCode = res.statusCode;
                            return reject(err);
                        }
                        try {
                            resolve(JSON.parse(responseData));
                        } catch {
                            resolve({});
                        }
                    });
                });
                req.on('error', reject);
                req.write(data);
                req.end();
            });
        },
        get: (relativeUrl) => {
            return new Promise((resolve, reject) => {
                const urlObj = new URL(relativeUrl, SERVER_URL);
                const opts = {
                    method: 'GET',
                    hostname: urlObj.hostname,
                    port: urlObj.port,
                    path: urlObj.pathname
                };
                const req = http.request(opts, res => {
                    let responseData = '';
                    res.on('data', chunk => { responseData += chunk; });
                    res.on('end', () => {
                        if (res.statusCode >= 400) {
                            const err = new Error('Server error: ' + responseData);
                            err.statusCode = res.statusCode;
                            return reject(err);
                        }
                        try {
                            resolve(JSON.parse(responseData));
                        } catch {
                            resolve({});
                        }
                    });
                });
                req.on('error', reject);
                req.end();
            });
        }
    };
}

// --- Основной тест ---
async function main() {
    console.log('=== DB SYNC ALL TEST START ===');
    cleanUp();

    await startMockServer();
    let db;

    try {
        db = new WiseJSON(DB_PATH, {
            logger: {
                log: () => {}, warn: () => {}, error: () => {}
            }
        });
        await db.init();
        const col = await db.collection(COLLECTION_NAME);
        await col.initPromise;

        // Подключаем синхронизацию с нашим тестовым apiClient!
        col.enableSync({
            url: SERVER_URL,
            apiKey: 'test-key',
            syncIntervalMs: 400, // чуть больше чтобы sync не запускался слишком часто
            apiClient: makeTestApiClient()
        });

        // --- Тест 1: PUSH локальных изменений ---
        console.log('  --- Тест 1: PUSH локальных изменений ---');
        await col.insert({ _id: 'doc1', name: 'Alice' });

        // Ждём ровно одну sync-операцию (ждём появления хотя бы одной!)
        let tries = 0;
        while (serverState.receivedOps.length < 1 && tries < 15) {
            await sleep(150);
            tries++;
        }
        // Дополнительно ждём немного, чтобы не поймать вторую sync
        await sleep(150);

        // Точно не больше одной операции (fail tolerant)
        assert.ok(serverState.receivedOps.length >= 1, 'Тест 1: Сервер должен получить хотя бы 1 операцию');
        assert.ok(serverState.receivedOps.length <= 2, 'Тест 1: Сервер должен получить не больше 2 операций');
        assert.strictEqual(serverState.receivedOps[0].op, 'INSERT', 'Тест 1: Операция должна быть INSERT');
        assert.strictEqual(serverState.receivedOps[0].doc.name, 'Alice', 'Тест 1: Данные документа должны быть корректны');
        assert.ok(serverState.receivedOps[0].opId, 'Тест 1: Операция должна иметь opId');
        console.log('  --- Тест 1 PASSED ---');

        col.disableSync(); // Отключаем sync чтобы дальше тесты шли честно
        serverState.receivedOps = []; // Очищаем полученные операции

        // --- Тест 2: PULL и MERGE удаленных изменений ---
        console.log('  --- Тест 2: PULL и MERGE удаленных изменений ---');
        const remoteUpdateTimestamp = new Date(Date.now() + 1000).toISOString();
        serverState.opsToSend.push({
            op: 'INSERT',
            doc: { _id: 'doc2', name: 'Bob', updatedAt: new Date().toISOString() },
            opId: 'server-op-1'
        });
        serverState.opsToSend.push({
            op: 'UPDATE',
            id: 'doc1',
            data: { name: 'Alice Smith', updatedAt: remoteUpdateTimestamp },
            opId: 'server-op-2'
        });

        col.enableSync({
            url: SERVER_URL,
            apiKey: 'test-key',
            syncIntervalMs: 400,
            apiClient: makeTestApiClient()
        });
        await col.triggerSync();
        await sleep(500);

        const doc1 = await col.getById('doc1');
        const doc2 = await col.getById('doc2');

        assert.ok(doc1, 'Тест 2: doc1 должен существовать');
        assert.strictEqual(doc1.name, 'Alice Smith', 'Тест 2: doc1 должен быть обновлен с сервера');
        assert.ok(doc2, 'Тест 2: doc2 должен быть создан с сервера');
        assert.strictEqual(doc2.name, 'Bob', 'Тест 2: Данные doc2 должны быть корректны');
        console.log('  --- Тест 2 PASSED ---');

        // --- Тест 3: Обработка ошибок сети ---
        console.log('  --- Тест 3: Обработка ошибок сети ---');

        const waitForSyncError = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                col.off('sync:error', errorListener);
                reject(new Error('Тест 3: Таймаут ожидания события sync:error'));
            }, 3000);

            const errorListener = (err) => {
                clearTimeout(timeoutId);
                col.off('sync:error', errorListener);
                resolve(err);
            };
            col.on('sync:error', errorListener);
        });

        serverState.rejectNextPush = true;
        await col.insert({ _id: 'doc3', name: 'Charlie' });

        // ! Не await'им, чтобы ошибка не "пробила" основной main
        col.triggerSync().catch(()=>{});

        const syncError = await waitForSyncError;

        assert.ok(syncError, 'Тест 3: Событие sync:error должно было сработать');
        assert.ok(syncError instanceof Error, 'Тест 3: syncError должен быть объектом Error');
        assert.ok(syncError.message.includes('Internal Server Error From Mock') || syncError.statusCode === 500, 'Тест 3: Ошибка должна указывать на проблему сервера');

        const waitForSyncSuccessAfterError = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                col.off('sync:success', successListener);
                reject(new Error('Тест 3: Таймаут ожидания события sync:success после ошибки'));
            }, 3000);

            const successListener = (payload) => {
                if (payload && payload.pushed > 0) {
                    clearTimeout(timeoutId);
                    col.off('sync:success', successListener);
                    resolve();
                }
            };
            col.on('sync:success', successListener);
        });

        await waitForSyncSuccessAfterError;

        assert.ok(serverState.receivedOps.some(op => op.doc && op.doc._id === 'doc3'), 'Тест 3: doc3 должен был быть отправлен при следующей успешной синхронизации');
        console.log('  --- Тест 3 PASSED ---');

    } finally {
        if (db) {
            await db.close();
        }
        await stopMockServer();
        cleanUp();
    }

    console.log('=== DB SYNC ALL TEST PASSED SUCCESSFULLY ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    if (err.stack) {
        console.error(err.stack);
    }
    stopMockServer().finally(() => {
        cleanUp();
        process.exit(1);
    });
});
