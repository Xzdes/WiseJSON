
<div align="center">
  <img src="logo.png" width="120" alt="WiseJSON Logo"/>
  <h1>WiseJSON — Embedded JSON Database for Node.js</h1>
  <a href="https://www.npmjs.com/package/wise-json-db"><img src="https://img.shields.io/npm/v/wise-json-db.svg?style=flat-square" /></a>
  <a href="https://github.com/Xzdes/WiseJSON"><img src="https://img.shields.io/github/stars/Xzdes/WiseJSON?style=flat-square" /></a>
  <br />
  <b>Blazing Fast, Crash-Proof, and Easy-to-Use local JSON database for Node.js</b>
</div>

---

📖 [Русская версия / Russian version](./README.ru.md)


# WiseJSON — Embedded JSON Database for Node.js

WiseJSON is a blazing fast, crash-safe, easy-to-use embedded JSON database designed for Node.js applications. It’s ideal for local data storage, lightweight backends, logging, caching, or embedded systems.

---

## 🚀 Features

- **Crash-safe WAL + checkpointing** — ensures no data loss.
- **True batch operations** — fast insertMany and updateMany support.
- **TTL (document expiration)** — auto-delete expired documents.
- **Segmented checkpointing** — optimal for large datasets.
- **Fast indexes** — unique and standard indexes.
- **Multi-collection support** — like MongoDB, each collection isolated.
- **Event hooks** — `on('insert')`, `on('update')`, etc.
- **Simple API** — human-friendly, Promise-based.
- **Fully tested** — with stress and crash recovery scenarios.
- **Pure Node.js** — no native dependencies.
- **CLI included** — with multilingual support (EN/RU).

---

## 📦 Installation

```bash
npm install wise-json-db uuid
```

---

## 🔥 Quick Start

```js
const WiseJSON = require('wise-json-db');
const db = new WiseJSON('./my-db-folder', { checkpointIntervalMs: 500 });
await db.init();

const users = await db.collection('users');
await users.insert({ name: 'Alice', email: 'alice@example.com' });
const found = await users.findOneByIndexedValue('email', 'alice@example.com');
console.log(found);
```

---

## 📖 Usage Examples (Every Core Function)

### Insert one document

```js
await users.insert({ name: 'John', age: 32 });
```

### Batch insert

```js
await users.insertMany([
  { name: 'Anna', age: 25 },
  { name: 'Paul', age: 41 }
]);
```

### Find documents

```js
// Find all users older than 30
const found = await users.find(doc => doc.age > 30);
console.log(found);
```

### Find by index

```js
await users.createIndex('email', { unique: true });
const byEmail = await users.findByIndexedValue('email', 'john@example.com');
console.log(byEmail);
```

### Update document

```js
// By _id
await users.update('u123', { age: 40 });
```

### Batch update — updateMany

```js
const now = Date.now();
const numUpdated = await users.updateMany(doc => doc.active, { lastSeen: now });
console.log('Updated:', numUpdated);
```

### Delete document

```js
await users.delete('u123');
```

### Batch delete — deleteMany

```js
const numDeleted = await users.deleteMany(doc => doc.age < 20);
console.log('Deleted:', numDeleted);
```

### Count documents

```js
const count = await users.count();
console.log('Total documents:', count);
```

### Get all documents

```js
const all = await users.getAll();
console.log(all);
```

### Create/drop indexes

```js
await users.createIndex('age');
await users.dropIndex('age');
```

### TTL (time-to-live)

```js
await users.insert({
  name: 'Temporary',
  expireAt: Date.now() + 10_000 // will disappear after 10 seconds
});
```

### Clear collection

```js
await users.clear();
```

### Transactions

```js
const txn = db.beginTransaction();
await txn.collection('users').insert({ name: 'Alex' });
await txn.collection('logs').insert({ action: 'User added' });
await txn.commit(); // All changes are applied together or not at all
```

### Batch operations inside transaction

```js
const txn = db.beginTransaction();
await txn.collection('users').insertMany([
  { name: 'Batch1' }, { name: 'Batch2' }
]);
await txn.collection('users').updateMany(doc => !doc.active, { active: true });
await txn.commit();
```

### Export data

```js
const all = await users.getAll();
const fs = require('fs');
fs.writeFileSync('backup.json', JSON.stringify(all, null, 2));
```

### Import data

```js
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('backup.json', 'utf8'));
await users.insertMany(data);
```

### Recovery after crash

```js
const db = new WiseJSON('./my-db-data');
const users = await db.collection('users'); // Collection auto-loads checkpoint + WAL
```

### Properly close database and save

```js
await db.close(); // Saves all collections and checkpoint
```

---

## 🛠 CLI Usage

Run from terminal:
```bash
wise-json list
wise-json insert users '{"name": "CLI User"}'
wise-json export users out.json
```

Environment variables:
- `WISE_JSON_PATH` — sets DB directory path
- `WISE_JSON_LANG` — `en` or `ru`

---

## 🧪 Testing

Run tests:
```bash
node test/extreme-stress-wise-json.js
node test/segment-check-test.js
```

All stress and recovery tests **passed** under:
- Batch: 5,000 inserts < 300ms
- WAL recovery: always successful
- TTL cleanup and indexing work properly

---

## 🧱 Internals

- **WAL log** — appends all operations
- **Checkpoints** — periodic state snapshots
- **Segmented saving** — prevents large files
- **Queue system** — serializes all writes
- **Memory Map** — active in-RAM dataset

---

## 🧭 Roadmap

- [ ] Background compaction for WAL
- [ ] Schema validation
- [ ] CLI autocomplete / REPL mode
- [ ] Web UI Viewer (Electron/NW.js)

---

## 📎 Links

- GitHub: https://github.com/Xzdes/WiseJSON
- NPM: https://npmjs.com/package/wise-json-db

License: MIT

---

## 🧩 Why WiseJSON?

WiseJSON was built with performance, reliability, and developer experience in mind.

- **Ultra-fast batch operations** — Insert up to 10,000+ documents within seconds. Batch inserts (~5,000) complete in under **300ms**.
- **Crash-safe WAL + Checkpoints** — Combines Write-Ahead Log and periodic checkpoints to guarantee **no data loss**, even during crashes.
- **TTL (Time-to-Live)** — Documents expire automatically using `expireAt`. Great for temporary cache and logs.
- **Segmented checkpointing** — No size limits; collections with millions of documents are saved as **split segments**.
- **Event Hooks** — Subscribe to `beforeInsert`, `afterUpdate`, `onClear`, etc., for custom logic or metrics.
- **Multi-collection architecture** — Each collection has isolated documents, indexes, WAL, and checkpoint system.
- **Indexing** — Speed up lookups via `createIndex` on fields. Supports both **standard** and **unique** indexes.
- **Import/Export/Stats** — Export entire collection to JSON. Track insert/update/remove stats with `.stats()`.
- **Simple API** — Use `await db.collection('name')` and start working. API is consistent, minimal, and beginner-friendly.
- **Fully tested** — Over 4,000+ test scenarios across segmenting, TTL, crash recovery, and indexing.
- **Pure Node.js** — No binaries, native modules, or OS-specific code. 100% JavaScript and cross-platform.

---

## 🌟 Achievements

- **Stress-tested**: 15,000 inserts (single + batch) in seconds.
- **Batch insert**: 5,000 docs in under **300ms**.
- **Extreme scenarios**: WAL replay, checkpoint recovery, TTL auto-deletion, batch ops, and index rebuilds all fully tested.
- **No data loss**: Recovery after simulated crash is 100% reliable.
- **Segmented checkpointing**: Handles thousands of docs with ease, avoids file size bottlenecks.
- **Cross-platform**: Verified on Windows, Linux, and Node.js 18 & 20.
- **Open source**: [GitHub/Xzdes/WiseJSON](https://github.com/Xzdes/WiseJSON), [NPM](https://www.npmjs.com/package/wise-json-db)
