// test/db-sync-all.js

const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const WiseJSON = require('../wise-json/index.js');
const { apiClient } = require('../index.js');

const DB_PATH = path.resolve(__dirname, 'db-sync-all-data');
const COLLECTION_NAME = 'sync_test_collection';
const SERVER_PORT = 13337;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// --- Мок-сервер (УЛУЧШЕННЫЙ) ---
let mockServer;
const serverState = {
    receivedOps: [],
    opsToSend: [],
    requestLog: [],
    rejectNextPush: false,
    snapshotDocuments: []
};

function startMockServer() {
    // Сброс состояния перед каждым запуском
    serverState.receivedOps = [];
    serverState.opsToSend = [];
    serverState.requestLog = [];
    serverState.rejectNextPush = false;
    serverState.snapshotDocuments = [];

    mockServer = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        serverState.requestLog.push({ method: req.method, url: url.pathname });
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');

            if (req.method === 'GET' && url.pathname === '/sync/snapshot') {
                res.writeHead(200);
                res.end(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    documents: serverState.snapshotDocuments
                }));
            } else if (req.method === 'GET' && url.pathname === '/sync/pull') {
                res.writeHead(200);
                res.end(JSON.stringify(serverState.opsToSend));
                serverState.opsToSend = []; // Очищаем после отправки
            } else if (req.method === 'POST' && url.pathname === '/sync/push') {
                if (serverState.rejectNextPush) {
                    serverState.rejectNextPush = false;
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: "Internal Server Error From Mock" }));
                    return;
                }
                try {
                    const payload = JSON.parse(body);
                    const ops = Array.isArray(payload.ops) ? payload.ops : [];
                    serverState.receivedOps.push(...ops);
                    res.writeHead(200);
                    res.end(JSON.stringify({ status: 'ok', received: ops.length }));
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Bad request to mock server' }));
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

// ИСПРАВЛЕНИЕ: Переписываем waitForEvent, чтобы он использовал .on() и .off()
function waitForEvent(emitter, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let listener; // Объявляем listener здесь, чтобы он был доступен в обоих замыканиях
    
    const timeoutId = setTimeout(() => {
      emitter.off(eventName, listener); // Отписываемся по таймауту
      reject(new Error(`Timeout waiting for event "${eventName}"`));
    }, timeoutMs);

    listener = (payload) => {
      clearTimeout(timeoutId);
      emitter.off(eventName, listener); // Отписываемся сразу после срабатывания
      resolve(payload);
    };
    
    emitter.on(eventName, listener); // Подписываемся через .on()
  });
}


// --- Основной тест ---
async function main() {
    console.log('=== DB SYNC ALL TEST START ===');
    cleanUp();

    await startMockServer();
    let db;

    try {
        db = new WiseJSON(DB_PATH);
        await db.init();
        const col = await db.collection(COLLECTION_NAME);
        await col.initPromise;

        const testApiClient = new apiClient(SERVER_URL, 'test-key');

        col.enableSync({
            apiClient: testApiClient,
            syncIntervalMs: 1000,
            url: SERVER_URL,
            apiKey: 'test-key'
        });

        // --- Тест 1: PUSH локальных изменений ---
        console.log('  --- Тест 1: PUSH локальных изменений ---');
        
        await waitForEvent(col, 'sync:initial_complete');

        await col.insert({ _id: 'doc1', name: 'Alice' });

        await waitForEvent(col, 'sync:push_success');
        
        assert.strictEqual(serverState.receivedOps.length, 1, 'Тест 1: Сервер должен получить ровно 1 операцию');
        assert.strictEqual(serverState.receivedOps[0].op, 'INSERT', 'Тест 1: Операция должна быть INSERT');
        assert.strictEqual(serverState.receivedOps[0].doc.name, 'Alice', 'Тест 1: Данные документа должны быть корректны');
        console.log('  --- Тест 1 PASSED ---');


        // --- Тест 2: PULL и MERGE удаленных изменений ---
        console.log('  --- Тест 2: PULL и MERGE удаленных изменений ---');
        serverState.opsToSend.push(
            { op: 'INSERT', doc: { _id: 'doc2', name: 'Bob', updatedAt: new Date().toISOString() }, ts: new Date().toISOString() },
            { op: 'UPDATE', id: 'doc1', data: { name: 'Alice Smith' }, ts: new Date().toISOString() }
        );

        await col.triggerSync();
        await waitForEvent(col, 'sync:pull_success');

        const doc1 = await col.getById('doc1');
        const doc2 = await col.getById('doc2');

        assert.ok(doc1, 'Тест 2: doc1 должен существовать');
        assert.strictEqual(doc1.name, 'Alice Smith', 'Тест 2: doc1 должен быть обновлен с сервера');
        assert.ok(doc2, 'Тест 2: doc2 должен быть создан с сервера');
        assert.strictEqual(doc2.name, 'Bob', 'Тест 2: Данные doc2 должны быть корректны');
        console.log('  --- Тест 2 PASSED ---');


        // --- Тест 3: Обработка ошибок сети ---
        console.log('  --- Тест 3: Обработка ошибок сети ---');
        serverState.rejectNextPush = true;

        await col.insert({ _id: 'doc3', name: 'Charlie' });
        
        col.triggerSync(); 
        const syncErrorPayload = await waitForEvent(col, 'sync:error');

        assert.ok(syncErrorPayload, 'Тест 3: Событие sync:error должно было сработать');
        assert.ok(syncErrorPayload.message.includes('Push failed'), 'Тест 3: Ошибка должна указывать на проблему с PUSH');

        col.triggerSync();
        await waitForEvent(col, 'sync:push_success');

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
        // cleanUp(); // Оставляем данные для отладки
        process.exit(1);
    });
});