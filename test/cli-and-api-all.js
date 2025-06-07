// test/cli-and-api-all.js

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const DB_PATH = path.resolve(__dirname, 'cli-and-api-db');
const CLI = `node explorer/cli.js`;
const SERVER = 'explorer/server.js';
const BASE_URL = 'http://127.0.0.1:3101';
const TEST_COLLECTION = 'cliapi_users';
const DATA_FILE = path.join(__dirname, 'cliapi-import.json');
const EXPORT_JSON = path.join(__dirname, 'cliapi-export.json');
const EXPORT_CSV = path.join(__dirname, 'cliapi-export.csv');
const AUTH_USER = 'apitest';
const AUTH_PASS = 'secret';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { recursive: true, force: true });
    [DATA_FILE, EXPORT_JSON, EXPORT_CSV].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
}

function run(command, opts = {}) {
    // Ключ: пробрасываем WISE_JSON_PATH в каждую CLI-команду!
    execSync(command, {
        stdio: opts.silent ? 'pipe' : 'inherit',
        env: { ...process.env, WISE_JSON_PATH: DB_PATH }
    });
}

function fetchJson(url, { auth } = {}) {
    return new Promise((resolve, reject) => {
        const opts = { headers: {} };
        if (auth) {
            const encoded = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
            opts.headers['Authorization'] = `Basic ${encoded}`;
        }
        http.get(url, opts, res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

function showDirStructure(dir) {
    if (!fs.existsSync(dir)) {
        console.log(`[debug] DIR NOT FOUND: ${dir}`);
        return;
    }
    console.log(`[debug] Contents of ${dir}:`);
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const full = path.join(dir, item);
        const stat = fs.statSync(full);
        console.log('   ', item, stat.isDirectory() ? '(dir)' : '');
        if (stat.isDirectory()) {
            const files = fs.readdirSync(full);
            for (const f of files) {
                console.log('      -', f);
            }
        }
    }
}

async function waitServerStart(proc, port) {
    for (let i = 0; i < 30; i++) {
        try {
            await fetchJson(`${BASE_URL}/api/collections`, { auth: true });
            return;
        } catch (e) { await new Promise(r => setTimeout(r, 200)); }
    }
    throw new Error('Server did not start');
}

async function main() {
    console.log('=== CLI AND API ALL TEST START ===');
    cleanUp();

    // Важно: логируем путь к БД
    console.log('[test] DB_PATH for CLI/API:', DB_PATH);

    // --- CLI PART ---

    // 1. Готовим данные
    const testUsers = [];
    for (let i = 0; i < 30; i++) testUsers.push({ name: `User${i}`, age: 20 + i, group: i % 3 });
    fs.writeFileSync(DATA_FILE, JSON.stringify(testUsers, null, 2));

    // 2. Импорт коллекции
    run(`${CLI} import-collection ${TEST_COLLECTION} ${DATA_FILE} --mode replace --allow-write`);

    // 3. Экспорт JSON и CSV
    run(`${CLI} export-collection ${TEST_COLLECTION} ${EXPORT_JSON}`);
    run(`${CLI} export-collection ${TEST_COLLECTION} ${EXPORT_CSV} --output csv`);

    assert(fs.existsSync(EXPORT_JSON), 'JSON export file not created');
    assert(fs.existsSync(EXPORT_CSV), 'CSV export file not created');

    // 4. Индексы
    run(`${CLI} create-index ${TEST_COLLECTION} name --allow-write`);
    run(`${CLI} list-indexes ${TEST_COLLECTION}`);
    run(`${CLI} drop-index ${TEST_COLLECTION} name --allow-write`);
    run(`${CLI} list-indexes ${TEST_COLLECTION}`);

    // 5. Find/filter (JSON, CLI) — фильтр с экранированными кавычками
    run(`${CLI} show-collection ${TEST_COLLECTION} --filter "{\\"age\\":{\\"$gt\\":25}}"`);
    run(`${CLI} show-collection ${TEST_COLLECTION} --filter "{\\"$or\\":[{\\"group\\":1},{\\"name\\":\\"User2\\"}]}"`);

    // 6. Ошибки: некорректный фильтр и отсутствующая коллекция
    let errorCaught = false;
    try { run(`${CLI} show-collection notexist --filter '{"badjson":}'`, { silent: true }); } catch { errorCaught = true; }
    assert(errorCaught, 'CLI: Bad filter did not error');
    errorCaught = false;
    try { run(`${CLI} get-document notexist someid`, { silent: true }); } catch { errorCaught = true; }
    assert(errorCaught, 'CLI: Not exist collection did not error');

    // --- Показываем структуру папки после CLI!
    showDirStructure(DB_PATH);

    // --- API PART ---

    // 7. Запускаем сервер с авторизацией (stdout виден!)
    process.env.WISE_JSON_PATH = DB_PATH;
    process.env.PORT = '3101';
    process.env.WISEJSON_AUTH_USER = AUTH_USER;
    process.env.WISEJSON_AUTH_PASS = AUTH_PASS;
    const serverProc = spawn('node', [SERVER], { stdio: 'inherit', env: process.env });
    await waitServerStart(serverProc, 3101);

    try {
        // 8. collections
        const collections = await fetchJson(`${BASE_URL}/api/collections`, { auth: true });
        console.log('[test] API collections:', collections.data);
        assert(Array.isArray(collections.data), 'API: collections not array');
        assert(collections.data.some(c => c.name === TEST_COLLECTION), 'API: missing test collection');

        // 9. limit/offset/sort
        const docs = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?limit=5`, { auth: true });
        assert(docs.data.length === 5, 'API: limit');
        const docs2 = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?offset=10&limit=7`, { auth: true });
        assert(docs2.data.length === 7, 'API: offset+limit');
        const sorted = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?sort=age&order=desc`, { auth: true });
        assert(sorted.data[0].age > sorted.data[1].age, 'API: sort order');

        // 10. Фильтры (равенство, gt, or)
        const byName = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?filter_name=User5`, { auth: true });
        assert(byName.data.length === 1 && byName.data[0].name === 'User5', 'API: filter_name');
        const byGt = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?filter_age__gt=29`, { auth: true });
        assert(byGt.data.every(u => u.age > 29), 'API: filter_age__gt');

        // 11. Авторизация: без auth 401
        let fail = false;
        try { await fetchJson(`${BASE_URL}/api/collections`); } catch { fail = true; }
        assert(fail, 'API: no-auth did not fail');

    } finally {
        serverProc.kill();
    }

    // --- CLEANUP (если всё прошло успешно) ---
    cleanUp();

    console.log('=== CLI AND API ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Директория/файлы не были удалены для ручной отладки: ${DB_PATH}`);
    showDirStructure(DB_PATH);
    process.exit(1);
});
