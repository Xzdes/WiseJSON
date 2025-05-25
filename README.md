
<div align="center">
  <img src="logo.png" width="100" alt="WiseJSON Logo"/>
  <h1>WiseJSON — Embedded JSON Database for Node.js</h1>
  <a href="https://www.npmjs.com/package/wise-json-db"><img src="https://img.shields.io/npm/v/wise-json-db.svg?style=flat-square" /></a>
  <a href="https://github.com/Xzdes/WiseJSON"><img src="https://img.shields.io/github/stars/Xzdes/WiseJSON?style=flat-square" /></a>
  <br />
  <b>Blazing Fast, Crash-Proof, and Easy-to-Use local JSON database for Node.js</b>
</div>

---

## 🚀 Features

- **Ultra-fast batch operations:** Insert up to 10,000+ docs in seconds, batch-insert in ~300ms.
- **WAL + Checkpoint crash safety:** Recovery is guaranteed after crash — your data and indexes are safe.
- **True batch, TTL/expire support:** InsertMany, updateMany, and document expiration work out of the box.
- **Segmented checkpointing:** No file size limits, works with millions of docs, automatic splitting.
- **Event hooks:** "before"/"after" events for advanced logic and logging.
- **Multiple collections:** Like MongoDB, with real index support.
- **Indexes:** Fast findOne/find by indexed field, unique indexes.
- **Stats & export/import:** Simple .stats(), full export/import to JSON.
- **Super easy API:** Start in 3 lines, no extra dependencies except [uuid](https://www.npmjs.com/package/uuid).
- **Pure Node.js, no native dependencies, cross-platform.**
- **Thoroughly tested:** All core, edge, and extreme scenarios covered.

---

## 🌟 Achievements

- **Stress-tested:** 15,000 inserts (single+batch) in seconds, batch insert 5,000 docs in **under 300ms**.
- **Extreme stress:** WAL, batch, TTL, export/import, index creation and recovery all pass.
- **No data loss:** Recovery after simulated crash is 100% reliable.
- **Segmented checkpointing:** Handles thousands of docs, no file-size issues.
- **Tested on Windows, Linux, Node.js 18/20+.**
- **Development is public:** [GitHub/Xzdes/WiseJSON](https://github.com/Xzdes/WiseJSON)  
  [NPM/wise-json-db](https://www.npmjs.com/package/wise-json-db)

---

## 📦 Installation

```bash
npm install wise-json-db uuid
```

---

## 🔥 Quick Start Example

```js
const WiseJSON = require('wise-json-db');
const db = new WiseJSON('./my-db-folder', { checkpointIntervalMs: 500 });
await db.init();

const users = await db.collection('users');
await users.insert({ name: 'Alice', email: 'alice@domain.com' });
const found = await users.findOneByIndexedValue('email', 'alice@domain.com');
console.log(found);
```

---

## 📘 Full Usage Examples

### Batch insert

```js
await users.insertMany([
  { name: 'Bob', email: 'bob@domain.com' },
  { name: 'Charlie', email: 'charlie@domain.com' }
]);
```

### Indexes

```js
await users.createIndex('email', { unique: true });
const user = await users.findOneByIndexedValue('email', 'bob@domain.com');
```

### TTL/expire

```js
await users.insert({
  name: 'Eve',
  email: 'eve@domain.com',
  expireAt: Date.now() + 1000 * 60 // expires in 1 min
});
```

### Export/import

```js
const data = await users.getAll();
require('fs').writeFileSync('users-export.json', JSON.stringify(data, null, 2));
// Import
const arr = JSON.parse(require('fs').readFileSync('users-export.json', 'utf8'));
await users.insertMany(arr);
```

---

## 🧪 Testing & Results

All tests (basic, stress, segment, WAL recovery, TTL, batch, export/import, recovery from crash, multi-collection) **passed**:

- `node test/extreme-stress-wise-json.js`
- `node test/extreme-test-wise-json.js`
- `node test/segment-check-test.js`
- `node test/stress-test-wise-json.js`

Results:
- **10,000 inserts**: ~2.5 seconds
- **5,000 batch inserts**: ~300 ms
- **WAL + checkpoint recovery**: 100% reliable
- **No data loss even under heavy load**

---

## 📖 API Reference

See [full API documentation on GitHub](https://github.com/Xzdes/WiseJSON#api).

---

## 🛠 Requirements

- Node.js 18 or newer
- Dependency: [uuid](https://www.npmjs.com/package/uuid)

---

## 📎 Links

- **GitHub:** [https://github.com/Xzdes/WiseJSON](https://github.com/Xzdes/WiseJSON)
- **NPM:** [https://www.npmjs.com/package/wise-json-db](https://www.npmjs.com/package/wise-json-db)
- [Full documentation and issues](https://github.com/Xzdes/WiseJSON)
- License: MIT

---
