<p align="center">
  <img src="./logo.png" alt="WiseJSON Logo" width="150"/>
</p>

<h1 align="center">WiseJSON</h1>
<p align="center">
  <a href="https://github.com/Xzdes/WiseJSON">GitHub</a> • <a href="https://www.npmjs.com/package/wise-json-db">NPM</a>
</p>
<p align="center">
  A safe, segment-based embedded JSON database for Node.js — minimal dependencies (<b>uuid</b>), high performance, maximum data safety.
</p>

---

## ✨ Features

- 🔒 **Write-ahead logging** (WAL) and <b>fsync</b> for no data loss
- 📦 **Segmented checkpoint storage** — robust and scalable
- 💡 **In-memory indexes** (standard and unique field support)
- ⚡ **No heavy dependencies** — only [uuid](https://www.npmjs.com/package/uuid)
- 📁 **Embedded** — no server, just files in your project
- 🔄 **Batch insert, export/import, and CLI tool**
- 🧪 **Battle-tested** — stress, crash and recovery scripts
- 🪝 **Hooks & events** — before/after for all key operations
- 🧮 **Stats** — per-collection operation statistics
- 🧰 **Ready for pkg, vercel/pkg** — bundle as a single binary!
- 🚀 **Production ready** — used in microservices, CLIs, bots, and desktop apps

---

## 📦 Dependency

- [uuid](https://www.npmjs.com/package/uuid) (for unique document IDs)

---

## 🚀 Quick Start

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
  console.log('User ID:', user._id);

  const found = await users.findOneByIndexedValue('email', 'alice@example.com');
  console.log('Found:', found);

  await db.close();
})();
```

---

## 📁 Storage Structure

```
my-db/
└── users/
    ├── _checkpoints/
    │   ├── checkpoint_meta_users_*.json
    │   └── checkpoint_data_users_*_segN.json
    └── users.wal.jsonl
```

- **WAL** — fast append-only log of changes
- **Checkpoints** — safe, multi-segment, easy to backup/restore

---

## 📘 Collection API

| Method                               | Description                                    |
|-------------------------------------- |------------------------------------------------|
| `insert(doc)`                        | Add new document                               |
| `insertMany([docs])`                 | Add multiple documents                         |
| `update(id, updates)`                | Update by ID                                   |
| `remove(id)`                         | Remove by ID                                   |
| `getById(id)`                        | Retrieve by ID                                 |
| `getAll()`                           | Get all documents                              |
| `count()`                            | Number of documents                            |
| `clear()`                            | Delete all documents                           |
| `createIndex(field, {unique})`       | Create index (with optional uniqueness)        |
| `findOneByIndexedValue(field, value)` | Find by unique index                           |
| `findByIndexedValue(field, value)`    | Find by standard index                         |
| `find(filter)`                       | Find by filter object or function              |
| `stats()`                            | Collection operation stats                     |
| `flushToDisk()`                      | Manually save checkpoint                       |
| `close()`                            | Save & close                                   |
| `on(event, listener)`                | Subscribe to events                            |

---

## 🪝 Events & Hooks

You can add listeners for any key operation:

```js
users.on('beforeInsert', doc => {
  doc.createdAt = new Date().toISOString();
});
users.on('afterInsert', doc => {
  console.log('Document inserted:', doc._id);
});
```

Supported events:  
- `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeRemove`, `afterRemove`, `beforeClear`, `afterClear`

---

## 🔎 Indexes

```js
await users.createIndex('email', { unique: true });
await users.insert({ name: 'Alice', email: 'alice@example.com' });
await users.insert({ name: 'Bob', email: 'alice@example.com' }); // Error!
```

---

## ⚙ Configuration

| Option                      | Default   | Description                                   |
|-----------------------------|-----------|-----------------------------------------------|
| `walForceSync`              | `true`    | Use fsync for safety                          |
| `checkpointIntervalMs`      | `300000`  | Interval for auto checkpoint (0 = off)        |
| `maxWalEntriesBeforeCheckpoint` | `1000` | Checkpoint after N ops                        |
| `maxSegmentSizeBytes`       | `1048576` | Segment size (bytes)                          |
| `checkpointsToKeep`         | `2`       | Generations to retain                         |

---

## 💻 CLI Usage

Export/import, insert, search, clear, list via CLI!

```bash
node wise-json/cli/wise-json-cli.js insert users name=Alice email=alice@example.com
node wise-json/cli/wise-json-cli.js export users > users.json
node wise-json/cli/wise-json-cli.js import users < users.json
node wise-json/cli/wise-json-cli.js find users email alice@example.com
node wise-json/cli/wise-json-cli.js clear users
```

---

## 🔄 Backup & Restore

- Just copy the `my-db/` directory (including all segments, WAL and checkpoints).
- For restore, just put files in place and open as usual.

---

## 🧪 Testing

```bash
node test/extreme-test-wise-json.js
node test/segment-check-test.js
```

---

## 🛡️ Fault Tolerance

- Safe WAL log and segment writing (temporary file + atomic rename)
- Survives crashes and forced process kills
- Recovery: loads from last checkpoint, then applies all WAL entries

---

## 🛠️ For Developers

- **Zero lock-in**: All data is JSON. Easily inspect, backup, move, or even recover manually.
- **Environment variable**: set `WISEJSON_DB_PATH` for the db path.
- **Extensible**: Add your own hooks and extensions.

---

## ❓ FAQ

**Q: Is it production ready?**  
A: Yes! Used in CLI tools, automation, bots, local servers, etc.

**Q: Can I use custom _id?**  
A: Yes, set your own or let WiseJSON generate with `uuid`.

**Q: How to clear all data safely?**  
A: Use `clear()` method or `cli clear`.

**Q: Can I store files/blobs?**  
A: Not directly, but you can store file metadata or base64.

---

## 📜 License

See LICENSE file.