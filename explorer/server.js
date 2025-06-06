/**
 * explorer/server.js
 * WiseJSON Data Explorer - HTTP Server
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const WiseJSON = require('../wise-json/index.js');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');
const db = new WiseJSON(DB_PATH);

async function startServer() {
    await db.init();

    const server = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        const query = parsedUrl.query;

        if (pathname === '/') {
            return serveStaticFile('index.html', res);
        }

        if (pathname.startsWith('/static/')) {
            const filePath = pathname.replace('/static/', '');
            return serveStaticFile(filePath, res);
        }

        if (pathname === '/api/collections') {
            const names = await db.getCollectionNames();
            const result = [];
            for (const name of names) {
                const col = await db.collection(name);
                await col.initPromise;
                const count = await col.count();
                result.push({ name, count });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result, null, 2));
            return;
        }

        const matchCollection = pathname.match(/^\/api\/collections\/([^\/]+)$/);
        if (matchCollection) {
            const colName = matchCollection[1];
            const col = await db.collection(colName);
            await col.initPromise;
            let docs = await col.getAll();

            // Фильтрация: filter_<field>=value (WARNING: только equals, небезопасно для сложных данных)
            // TODO: Расширить синтаксис фильтрации (например, filter_<field>__gt, __lt и др.)
            for (const [key, value] of Object.entries(query)) {
                if (key.startsWith('filter_')) {
                    const field = key.slice(7);
                    docs = docs.filter(doc => String(doc[field]) === value);
                }
            }

            // Сортировка
            if (query.sort) {
                const field = query.sort;
                const order = query.order === 'desc' ? -1 : 1;
                docs.sort((a, b) => {
                    const av = a[field];
                    const bv = b[field];
                    if (av === undefined) return 1;
                    if (bv === undefined) return -1;
                    if (av < bv) return -1 * order;
                    if (av > bv) return 1 * order;
                    return 0;
                });
            }
            // Пагинация
            const offset = parseInt(query.offset || '0', 10);
            const limit = parseInt(query.limit || '10', 10);
            docs = docs.slice(offset, offset + limit);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(docs, null, 2));
            return;
        }

        const matchCollectionStats = pathname.match(/^\/api\/collections\/([^\/]+)\/stats$/);
        if (matchCollectionStats) {
            const colName = matchCollectionStats[1];
            const col = await db.collection(colName);
            await col.initPromise;
            const stats = await col.stats();
            const indexes = await col.getIndexes();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...stats, indexes }, null, 2));
            return;
        }

        const matchDocument = pathname.match(/^\/api\/collections\/([^\/]+)\/doc\/(.+)$/);
        if (matchDocument) {
            const colName = matchDocument[1];
            const docId = matchDocument[2];
            const col = await db.collection(colName);
            await col.initPromise;
            const doc = await col.getById(docId);
            if (!doc) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Document not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(doc, null, 2));
            return;
        }

        // WARNING: Безопасность
        // Внимание: Встроенный сервер Data Explorer НЕ содержит никакой аутентификации/авторизации.
        // Используйте только в закрытых, доверенных локальных сетях/на локальной машине.
        // TODO: Если потребуется для production, добавить слой auth (например, по токену/логину).

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(PORT, () => {
        console.log(`WiseJSON Data Explorer running at http://127.0.0.1:${PORT}/`);
        // WARNING: Эксплорер открыт без авторизации! Не используйте в публичных сетях!
    });
}

function serveStaticFile(filename, res) {
    const filePath = path.join(__dirname, 'views', filename);
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
    }

    const ext = path.extname(filePath);
    const contentType = getContentType(ext);
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
}

function getContentType(ext) {
    switch (ext) {
        case '.html':
            return 'text/html';
        case '.css':
            return 'text/css';
        case '.js':
            return 'application/javascript';
        case '.json':
            return 'application/json';
        default:
            return 'text/plain';
    }
}

startServer();
