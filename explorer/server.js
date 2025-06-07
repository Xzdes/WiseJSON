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

console.log('[server.js] DB_PATH used:', DB_PATH);

const db = new WiseJSON(DB_PATH);

// --- AUTH (Basic) ---
const AUTH_USER = process.env.WISEJSON_AUTH_USER;
const AUTH_PASS = process.env.WISEJSON_AUTH_PASS;
const useAuth = !!(AUTH_USER && AUTH_PASS);

function parseBasicAuth(header) {
    if (!header || !header.startsWith('Basic ')) return null;
    const b64 = header.slice('Basic '.length).trim();
    try {
        const str = Buffer.from(b64, 'base64').toString('utf8');
        const [user, pass] = str.split(':');
        return { user, pass };
    } catch {
        return null;
    }
}

function checkAuth(req, res) {
    if (!useAuth) return true;
    const auth = req.headers['authorization'];
    const creds = parseBasicAuth(auth);
    if (!creds || creds.user !== AUTH_USER || creds.pass !== AUTH_PASS) {
        res.writeHead(401, {
            'WWW-Authenticate': 'Basic realm="WiseJSON Data Explorer"',
            'Content-Type': 'text/plain'
        });
        res.end('401 Unauthorized');
        return false;
    }
    return true;
}

// --- FILTERS (как раньше, для REST API) ---
function parseFilterFromQuery(query) {
    const filter = {};
    for (const [key, value] of Object.entries(query)) {
        if (key.startsWith('filter_')) {
            const tail = key.slice('filter_'.length);
            const [field, ...ops] = tail.split('__');
            if (!field) continue;
            let v = value;
            if (/^-?\d+(\.\d+)?$/.test(v)) v = parseFloat(v);
            if (ops.length === 0) {
                filter[field] = v;
            } else {
                const op = '__' + ops.join('__');
                if (!filter[field]) filter[field] = {};
                switch (op) {
                    case '__gt': filter[field]['$gt'] = v; break;
                    case '__lt': filter[field]['$lt'] = v; break;
                    case '__gte': filter[field]['$gte'] = v; break;
                    case '__lte': filter[field]['$lte'] = v; break;
                    case '__ne': filter[field]['$ne'] = v; break;
                    case '__in':
                        filter[field]['$in'] = typeof v === 'string' ? v.split(',') : v;
                        break;
                    case '__nin':
                        filter[field]['$nin'] = typeof v === 'string' ? v.split(',') : v;
                        break;
                    case '__regex':
                        filter[field]['$regex'] = v;
                        break;
                    default:
                        break;
                }
            }
        }
    }
    return filter;
}

function matchFilter(doc, filter) {
    if (typeof filter !== 'object' || filter == null) return false;
    if (Array.isArray(filter.$or)) {
        return filter.$or.some(f => matchFilter(doc, f));
    }
    if (Array.isArray(filter.$and)) {
        return filter.$and.every(f => matchFilter(doc, f));
    }
    for (const key of Object.keys(filter)) {
        if (key === '$or' || key === '$and') continue;
        const cond = filter[key];
        const value = doc[key];
        if (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) {
            for (const op of Object.keys(cond)) {
                const opVal = cond[op];
                switch (op) {
                    case '$gt': if (!(value > opVal)) return false; break;
                    case '$gte': if (!(value >= opVal)) return false; break;
                    case '$lt': if (!(value < opVal)) return false; break;
                    case '$lte': if (!(value <= opVal)) return false; break;
                    case '$ne': if (value === opVal) return false; break;
                    case '$in': if (!Array.isArray(opVal) || !opVal.includes(value)) return false; break;
                    case '$nin': if (Array.isArray(opVal) && opVal.includes(value)) return false; break;
                    case '$regex': {
                        let re = opVal;
                        if (typeof re === 'string') re = new RegExp(re, cond.$options || '');
                        if (typeof value !== 'string' || !re.test(value)) return false;
                        break;
                    }
                    default: return false;
                }
            }
        } else {
            if (value !== cond) return false;
        }
    }
    return true;
}

async function startServer() {
    await db.init();

    const server = http.createServer(async (req, res) => {
        // AUTH CHECK (до любого запроса)
        if (!checkAuth(req, res)) return;

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
            // ЯВНО логируем что возвращаем:
            console.log('[server.js] /api/collections result:', result);
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

            const filter = parseFilterFromQuery(query);
            if (Object.keys(filter).length > 0) {
                docs = docs.filter(doc => matchFilter(doc, filter));
            }

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

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(PORT, () => {
        if (useAuth) {
            console.log(`WiseJSON Data Explorer (auth required) at http://127.0.0.1:${PORT}/`);
        } else {
            console.log(`WiseJSON Data Explorer running at http://127.0.0.1:${PORT}/`);
            console.log('WARNING: Explorer открыт без авторизации! Не используйте в публичных сетях!');
        }
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
        case '.html': return 'text/html';
        case '.css': return 'text/css';
        case '.js': return 'application/javascript';
        case '.json': return 'application/json';
        default: return 'text/plain';
    }
}

startServer();
