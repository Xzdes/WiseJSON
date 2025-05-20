<p align="center">
  <img src="./logo.png" alt="WiseJSON Logo" width="150"/>
</p>

<h1 align="center">WiseJSON</h1>
<p align="center">
  A reliable, segment-based embedded JSON database for Node.js — with zero dependencies.
</p>

---

## ✨ Features

- 🔒 **Safe by design** – WAL (write-ahead log) + fsync for zero data loss
- 📦 **Segmented checkpoint storage** – fast, efficient, and scalable
- 💡 **In-memory indexes** – standard and unique field support
- ⚡ **No dependencies** – clean CommonJS modules only
- 📁 **Fully embedded** – no server, no daemon, just files
- 🔧 **Works with pkg** – easily bundle into CLI or apps
- 🧪 **Battle-tested** – includes extreme, crash, and recovery tests

---

## 🚀 Getting Started

```bash
npm install wise-json-db
```

```js
const WiseJSON = require('wise-json-db');

const db = new WiseJSON('./my-db');

(async () => {
  const users = await db.collection('users');

  await users.createIndex('email', { unique: true });

  const user = await users.insert({ name: 'Alice', email: 'alice@example.com' });
  console.log(user._id);

  const found = await users.findOneByIndexedValue('email', 'alice@example.com');
  console.log(found);

  await db.close();
})();
```

---

## 📁 Storage Structure

```plaintext
my-db/
└── users/
    ├── _checkpoints/
    │   ├── checkpoint_meta_users_*.json
    │   └── checkpoint_data_users_*_segN.json
    └── users.wal.jsonl
```

---

## 📘 Collection API

| Method | Description |
|--------|-------------|
| `insert(doc)` | Add new document |
| `update(id, updates)` | Modify document by ID |
| `remove(id)` | Delete document |
| `getById(id)` | Retrieve document by ID |
| `getAll()` | Get all documents |
| `count()` | Count documents |
| `clear()` | Clear all documents |
| `createIndex(field, {unique})` | Create index (with optional uniqueness) |
| `findOneByIndexedValue(field, value)` | Find document by indexed field |
| `findByIndexedValue(field, value)` | Find many documents by indexed value |
| `flushToDisk()` | Manually trigger checkpoint |
| `close()` | Persist and release memory |

---

## ⚙ Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `walForceSync` | `true` | Use fsync for write safety |
| `checkpointIntervalMs` | `300000` | Interval for automatic checkpoints (0 = disabled) |
| `maxWalEntriesBeforeCheckpoint` | `1000` | Trigger checkpoint after N operations |
| `maxSegmentSizeBytes` | `1048576` | Max JSON segment size in bytes |
| `checkpointsToKeep` | `2` | How many generations to retain |

---

## 🔎 Indexes

```js
await users.createIndex('email', { unique: true });

await users.insert({ name: 'Alice', email: 'alice@example.com' });
await users.insert({ name: 'Bob', email: 'alice@example.com' }); // ❌ Error — duplicate!
```

- In-memory only, rebuilt on load
- Fast access with `findByIndexedValue`
- Unique constraint enforced

---

## 🧪 Testing

WiseJSON includes powerful internal test scripts:

```bash
node test/extreme-test-wise-json.js
node test/segment-check-test.js
```

- WAL load under fsync
- Segmented checkpoint validation
- Crash-tolerance logic
- Recovery from deletion or corruption

---

## 💻 CLI Tool

```bash
node wise-json/cli/wise-json-cli.js insert users name=Alice email=alice@example.com
node wise-json/cli/wise-json-cli.js list users
node wise-json/cli/wise-json-cli.js find users email alice@example.com
node wise-json/cli/wise-json-cli.js clear users
```

Or link it globally:

```bash
npm link
wise-json insert users name=Test
```

---

## 🧯 Fault Tolerance

- Write-ahead logging (WAL) with fsync
- Checkpoints via temporary file + rename
- Rebuilds from latest meta + segments + WAL
- Safe index reconstruction

---

## 🛠 Use Cases

- CLI tools (can be bundled with `pkg`)
- Microservices without a DBMS
- Local-first or offline apps
- Quick data stores without external engines

---

## 📜 License

**MIT License**

Copyright (c) 2025 Guliaev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.