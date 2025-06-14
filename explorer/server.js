/**
 * explorer/server.js
 * WiseJSON Data Explorer - HTTP Server
 */

const http = require('http');
const url = require('url');
const fs =require('fs');
const path = require('path');
const WiseJSON = require('../wise-json/index.js');
const { matchFilter } = require('../wise-json/collection/utils.js');
const logger = require('../wise-json/logger');

// --- Конфигурация ---
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');
const AUTH_USER = process.env.WISEJSON_AUTH_USER;
const AUTH_PASS = process.env.WISEJSON_AUTH_PASS;
const USE_AUTH = !!(AUTH_USER && AUTH_PASS);
// ИСПРАВЛЕНИЕ: Проверяем переменную окружения, а не аргумент
const ALLOW_WRITE = process.env.WISEJSON_EXPLORER_ALLOW_WRITE === 'true';

logger.log(`[Server] DB Path: ${DB_PATH}`);
logger.log(`[Server] Write Operations Allowed: ${ALLOW_WRITE}`);

const db = new WiseJSON(DB_PATH);

// --- Вспомогательные функции ---

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
}

function sendError(res, statusCode, message) {
    sendJson(res, statusCode, { error: message });
}

function checkAuth(req, res) {
    if (!USE_AUTH) return true;
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="WiseJSON Data Explorer"' });
        res.end('Unauthorized');
        return false;
    }
    const b64 = authHeader.slice('Basic '.length).trim();
    const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');

    if (user === AUTH_USER && pass === AUTH_PASS) {
        return true;
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="WiseJSON Data Explorer"' });
    res.end('Unauthorized');
    return false;
}

function serveStaticFile(filename, res) {
    const filePath = path.join(__dirname, 'views', filename);
    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
    };
    try {
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
        fs.createReadStream(filePath).pipe(res);
    } catch {
        sendError(res, 404, 'Static file not found.');
    }
}

function parseFilterFromQuery(query) {
    const filter = {};
    for (const [key, value] of Object.entries(query)) {
        if (key.startsWith('filter_')) {
            const tail = key.slice('filter_'.length);
            const [field, op] = tail.split('__');
            let v = value;
            if (/^-?\d+(\.\d+)?$/.test(v)) v = parseFloat(v);
            if (op) {
                if (!filter[field]) filter[field] = {};
                filter[field][`$${op}`] = v;
            } else {
                filter[field] = v;
            }
        }
    }
    return filter;
}


// --- Основной обработчик запросов ---
async function requestHandler(req, res) {
    if (!checkAuth(req, res)) return;

    const parsedUrl = url.parse(req.url, true);
    const { pathname, query } = parsedUrl;
    const method = req.method.toUpperCase();
    
    // --- Роутинг ---
    if (pathname === '/') return serveStaticFile('index.html', res);
    if (pathname.startsWith('/static/')) return serveStaticFile(pathname.slice('/static/'.length), res);

    if (pathname === '/api/collections' && method === 'GET') {
        const names = await db.getCollectionNames();
        const result = await Promise.all(names.map(async (name) => {
            const col = await db.collection(name);
            await col.initPromise;
            return { name, count: await col.count() };
        }));
        return sendJson(res, 200, result);
    }

    const collectionRouteMatch = pathname.match(/^\/api\/collections\/([^\/]+)\/?$/);
    if (collectionRouteMatch && method === 'GET') {
        const colName = collectionRouteMatch[1];
        const col = await db.collection(colName);
        await col.initPromise;
        
        const filter = parseFilterFromQuery(query);
        let filterObj = {};
        if (query.filter) {
            try { filterObj = JSON.parse(query.filter); } catch {}
        }

        let docs = await col.find({ ...filter, ...filterObj });

        if (query.sort) {
            docs.sort((a, b) => {
                if (a[query.sort] < b[query.sort]) return query.order === 'desc' ? 1 : -1;
                if (a[query.sort] > b[query.sort]) return query.order === 'desc' ? -1 : 1;
                return 0;
            });
        }
        const offset = parseInt(query.offset || '0', 10);
        const limit = parseInt(query.limit || '10', 10);
        return sendJson(res, 200, docs.slice(offset, offset + limit));
    }
    
    const statsRouteMatch = pathname.match(/^\/api\/collections\/([^\/]+)\/stats$/);
    if (statsRouteMatch && method === 'GET') {
        const colName = statsRouteMatch[1];
        const col = await db.collection(colName);
        await col.initPromise;
        const stats = await col.stats();
        const indexes = await col.getIndexes();
        return sendJson(res, 200, { ...stats, indexes });
    }

    const docRouteMatch = pathname.match(/^\/api\/collections\/([^\/]+)\/doc\/(.+)$/);
    if (docRouteMatch) {
        const colName = docRouteMatch[1];
        const docId = docRouteMatch[2];
        const col = await db.collection(colName);
        await col.initPromise;

        if (method === 'GET') {
            const doc = await col.getById(docId);
            return doc ? sendJson(res, 200, doc) : sendError(res, 404, 'Document not found.');
        }

        if (method === 'DELETE') {
            if (!ALLOW_WRITE) return sendError(res, 403, 'Write operations are disabled.');
            const success = await col.remove(docId);
            return success ? sendJson(res, 200, { message: 'Document removed' }) : sendError(res, 404, 'Document not found.');
        }
    }
    
    const indexRouteMatch = pathname.match(/^\/api\/collections\/([^\/]+)\/indexes\/?([^\/]+)?$/);
    if (indexRouteMatch) {
        if (!ALLOW_WRITE) return sendError(res, 403, 'Write operations are disabled.');
        const colName = indexRouteMatch[1];
        const fieldName = indexRouteMatch[2];
        const col = await db.collection(colName);
        await col.initPromise;
        
        if (method === 'POST' && !fieldName) {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const { fieldName: newFieldName, unique } = JSON.parse(body);
                    if (!newFieldName) return sendError(res, 400, 'fieldName is required.');
                    await col.createIndex(newFieldName, { unique: !!unique });
                    sendJson(res, 201, { message: `Index on "${newFieldName}" created.` });
                } catch (e) {
                    sendError(res, 500, e.message);
                }
            });
            return;
        }

        if (method === 'DELETE' && fieldName) {
            try {
                await col.dropIndex(fieldName);
                sendJson(res, 200, { message: `Index on "${fieldName}" dropped.` });
            } catch(e) {
                sendError(res, 500, e.message);
            }
            return;
        }
    }

    return sendError(res, 404, 'Not Found');
}

// --- Запуск сервера ---
async function startServer() {
    await db.init();
    const server = http.createServer((req, res) => {
        requestHandler(req, res).catch(err => {
            logger.error(`[Server] Unhandled request error: ${err.message}`);
            sendError(res, 500, 'Internal Server Error');
        });
    });

    server.listen(PORT, () => {
        if (USE_AUTH) {
            logger.log(`WiseJSON Data Explorer (auth required) is running at http://127.0.0.1:${PORT}/`);
        } else {
            logger.log(`WiseJSON Data Explorer is running at http://127.0.0.1:${PORT}/`);
        }
        if (!ALLOW_WRITE) {
            logger.warn('Server is in read-only mode. Set WISEJSON_EXPLORER_ALLOW_WRITE=true to enable changes.');
        }
    });
}

startServer();