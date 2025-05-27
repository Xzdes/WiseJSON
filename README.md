<div align="center">
  <img src="logo.png" width="120" alt="WiseJSON Logo"/>

# WiseJSON

![Node.js CI](https://img.shields.io/github/workflow/status/Xzdes/WiseJSON/Node.js%20CI/main)
![npm](https://img.shields.io/npm/v/wise-json)
![license](https://img.shields.io/github/license/Xzdes/WiseJSON)
![Downloads](https://img.shields.io/npm/dm/wise-json)

> **Lightweight, embedded JSON database for Node.js. Fast, transactional, safe.**
>
> _Русская версия ниже:_ [README.ru.md](./README.ru.md)

---

## Table of Contents

- [About](#about)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Usage](#api-usage)
  - [Collection API](#collection-api)
  - [Transactions](#transactions)
- [CLI Usage](#cli-usage)
- [Testing](#testing)
- [Advanced](#advanced)
- [Roadmap / Progress](#roadmap--progress)
- [License](#license)

---

## About

**WiseJSON** is an easy-to-use, embedded (file-based, not server) NoSQL database for Node.js.  
Ideal for local apps, CLI, scripts, and prototypes — and even small production backends.

- **Works out of the box:** just `require` and go.
- **No binary dependencies** (pure Node.js).
- **Supports**: indexes, transactions, TTL, checkpointing, WAL, flexible CLI.

---

## Features

- Fast **CRUD** for JSON documents
- **Safe Write-Ahead Log (WAL)** and checkpointing for data integrity
- **Indexes** for fast search
- **TTL (Time-to-live):** auto-expire docs
- **Transactions** (multi-collection, ACID-like)
- **Graceful shutdown:** all data saved on exit/SIGINT/SIGTERM
- **CLI**: powerful and safe, JSON and JS predicate queries, import/export
- **All code is open & readable!**
- **Full test runner** (all scripts auto-checked)

---

## Installation

```bash
npm install wise-json
```

Or, for CLI only:

```bash
npm install -g wise-json
```

---

## Quick Start

**Node.js:**

```js
const WiseJSON = require('wise-json');
const db = new WiseJSON('./my-db');

// Use a collection:
(async () => {
  const users = await db.collection('users');
  await users.insert({ name: 'Alice', age: 23 });
  const found = await users.find(doc => doc.age > 20);
  console.log(found); // [ { name: 'Alice', age: 23, ... } ]
})();
```

**CLI:**

```bash
wise-json insert users '{"name":"Bob","age":30}'
wise-json find users '{"age":30}'
```

---

## API Usage

### Collection API

All methods are `async`.

| Method                                  | Description                                                   |
| ---------------------------------------- | ------------------------------------------------------------- |
| `insert(doc)`                           | Insert a single document                                      |
| `insertMany(docs)`                      | Insert multiple documents (array)                             |
| `update(id, updates)`                   | Update document by id                                         |
| `updateMany(queryFn, updates)`          | Update all docs matching a predicate                          |
| `remove(id)`                            | Remove document by id                                         |
| `clear()`                               | Remove all documents                                          |
| `getById(id)`                           | Get document by id                                            |
| `getAll()`                              | Get all docs (alive)                                          |
| `count()`                               | Count all alive docs                                          |
| `find(queryFn)`                         | Find docs by predicate (function)                             |
| `findOne(queryFn)`                      | Find one doc by predicate                                     |
| `createIndex(fieldName, options)`        | Create an index on a field (`{unique: true/false}`)           |
| `dropIndex(fieldName)`                   | Drop index by field name                                      |
| `getIndexes()`                          | Get all index metadata                                        |
| `findOneByIndexedValue(field, value)`    | Fast search for one doc by indexed field                      |
| `findByIndexedValue(field, value)`       | Fast search for all docs with field=value (via index)         |
| `flushToDisk()`                         | Force checkpoint/save to disk                                 |
| `close()`                               | Stop timers, checkpoint, release resources                    |
| `stats()`                               | Get operation statistics                                      |
| `on(event, listener)`/`off(event, fn)`  | Subscribe/unsubscribe to collection events                    |

#### Example

```js
const users = await db.collection('users');
await users.insert({ name: 'John', age: 30 });
await users.createIndex('name', { unique: false });
const johns = await users.findByIndexedValue('name', 'John');
console.log(johns);
```

---

### Transactions

You can perform multi-collection atomic transactions.

```js
const txn = db.beginTransaction();
await txn.collection('users').insert({ name: 'Bob' });
await txn.collection('logs').insert({ msg: 'Bob added' });
await txn.commit();
```

- Transactions are all-or-nothing (atomic).
- If an error happens before commit, all changes are rolled back.

---

## CLI Usage

### Help

```bash
wise-json help
```

### Commands

- `list` — List all collections
- `info <collection>` — Stats and indexes
- `insert <collection> <json>` — Insert one doc
- `insert-many <collection> <file.json> [--ttl <ms>]` — Batch insert from file (optionally with TTL)
- `find <collection> [filter] [--unsafe-eval]` — Find docs (see below)
- `get <collection> <id>` — Get doc by id
- `remove <collection> <id>` — Remove doc by id
- `clear <collection>` — Clear collection
- `export <collection> <file.json>` — Export collection to file
- `import <collection> <file.json>` — Import docs from file

### Filtering

You can filter in two ways:
1. **JSON filter** (safe, default):

    ```bash
    wise-json find users '{"age":30}'
    ```

2. **JS predicate (eval)** — use `--unsafe-eval`:

    ```bash
    wise-json find users 'doc => doc.age > 18' --unsafe-eval
    ```

    > ⚠️ **Warning:** Only use eval with trusted code!  
      This flag is required for security.

---

## Testing

Run **all test scripts** (requires Node.js):

```bash
node test/run-all-tests.js
# or (if added to package.json scripts)
npm test
```

---

## Advanced

- **TTL:** Documents with `expireAt` field (timestamp in ms) auto-expire.
- **Graceful Shutdown:** Data is auto-saved on exit/signals.
- **Strict WAL error handling:** see `wal-manager.js` for `strict` and `onError` options.
- **Indexes:** Fast unique or non-unique search on any field.
- **Checkpointing:** Data periodically checkpointed for fast recovery.

---

## Roadmap / Progress

- [x] Graceful shutdown (no double-handling)
- [x] Strict/Callback WAL parsing
- [x] Safe CLI: JSON filters or `--unsafe-eval`
- [x] Automatic test runner for all scripts
- [x] Full event system
- [ ] Hot backup & restore
- [ ] Replication / Remote sync (planned)
- [ ] Web UI (planned)

---

## License

MIT

---

**Русская версия:** [README.ru.md](./README.ru.md)
