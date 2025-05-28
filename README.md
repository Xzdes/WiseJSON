<div align="center">
  <img src="logo.png" width="120" alt="WiseJSON Logo"/>
  <h1>WiseJSON</h1>

  <p>
    <a href="https://github.com/Xzdes/WiseJSON/actions/workflows/main.yml">
      <img src="https://img.shields.io/github/workflow/status/Xzdes/WiseJSON/Node.js%20CI/main" alt="Node.js CI"/>
    </a>
    <a href="https://www.npmjs.com/package/wise-json">
      <img src="https://img.shields.io/npm/v/wise-json" alt="npm"/>
    </a>
    <a href="https://github.com/Xzdes/WiseJSON/blob/main/LICENSE">
      <img src="https://img.shields.io/github/license/Xzdes/WiseJSON" alt="license"/>
    </a>
    <a href="https://www.npmjs.com/package/wise-json">
      <img src="https://img.shields.io/npm/dm/wise-json" alt="Downloads"/>
    </a>
  </p>

  **A lightweight, embeddable JSON database for Node.js. Fast, reliable, and simple.**  
  _Русская версия: [README.ru.md](./README.ru.md)_
</div>

---

## Table of Contents
- [About](#about)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [Node.js](#nodejs)
  - [CLI](#cli)
- [API (Node.js)](#api-nodejs)
- [CLI Commands](#cli-commands)
- [Filtering](#filtering)
- [Testing](#testing)
- [Additional](#additional)
- [Roadmap](#roadmap)
- [License](#license)

---

## About

**WiseJSON** is a lightweight, fast, and easy-to-use NoSQL JSON database for Node.js,  
operating entirely as files without servers or external dependencies.

- **Out-of-the-box:** require and go!  
- **No binary dependencies** (pure Node.js).  
- **Supports:** indexes, transactions, TTL, checkpoint, WAL, CLI.

---

## Features

- Fast **CRUD** for JSON documents  
- **Reliable Write-Ahead Log (WAL)** and checkpoint for durability  
- **Indexes** for fast lookups  
- **TTL:** automatic expiration of documents  
- **Transactions** (multi-collection, ACID-like)  
- **Graceful shutdown:** data safety on exit or signals  
- **CLI:** powerful and safe filters via JSON and JS predicates, import/export  
- Full test runner  

---

## Installation

```bash
npm install wise-json
```

For global CLI installation:

```bash
npm install -g wise-json
```

---

## Quick Start

### Node.js

```js
const WiseJSON = require('wise-json');
const db = new WiseJSON('./my-db');

(async () => {
  const users = await db.collection('users');
  await users.insert({ name: 'Alice', age: 23 });
  const found = await users.find(doc => doc.age > 20);
  console.log(found); // [ { name: 'Alice', age: 23, ... } ]
})();
```

### CLI

```bash
wise-json insert users '{"name":"Bob","age":30}'
wise-json find users '{"age":30}'
```

---

## API (Node.js)

All methods are asynchronous (`async`).

| Method                          | Description                                      |
| ------------------------------- | ------------------------------------------------ |
| `insert(doc)`                   | Insert a single document                         |
| `insertMany(docs)`              | Insert multiple documents                        |
| `update(id, updates)`           | Update a document by id                          |
| `updateMany(queryFn, updates)`  | Update all documents matching a predicate        |
| `remove(id)`                    | Remove a document by id                          |
| `clear()`                       | Clear the entire collection                      |
| `getById(id)`                   | Retrieve a document by id                        |
| `getAll()`                      | Retrieve all "live" documents                    |
| `count()`                       | Count of "live" documents                        |
| `find(queryFn)`                 | Find documents using a predicate function        |

---

## CLI Commands

- `list` — List all collections  
- `info <collection>` — Show stats and indexes  
- `insert <collection> <json>` — Insert a document  
- `insert-many <collection> <file.json> [--ttl <ms>]` — Bulk insert from file  
- `find <collection> [filter] [--unsafe-eval]` — Find documents  
- `get <collection> <id>` — Get a document by id  
- `remove <collection> <id>` — Remove a document by id  
- `clear <collection>` — Clear a collection  
- `export <collection> <file.json>` — Export a collection to file  
- `import <collection> <file.json>` — Import from file  

---

## Filtering

1. **JSON filter** (safe):

   ```bash
   wise-json find users '{"age":30}'
   ```

2. **JS function (eval)** — with `--unsafe-eval` flag:

   ```bash
   wise-json find users 'doc => doc.age > 18' --unsafe-eval
   ```

> ⚠️ **Warning:** eval is only allowed with the explicit flag.

---

## Testing

Run all tests:

```bash
node test/run-all-tests.js
# or
npm test
```

---

## Additional

- **TTL:** Documents with an `expireAt` timestamp (ms) auto-expire.  
- **Graceful Shutdown:** Data is saved on exit or signal.  
- **Strict WAL handling:** See `wal-manager.js` options (`strict`, `onError`).  
- **Indexes:** Supports unique and non-unique indexes.  
- **Checkpoint:** Automatic periodic snapshot.  

---

## Roadmap

- [x] Full test runner  
- [x] Collection events system  
- [ ] Hot backup & restore  
- [ ] Replication / Sync (planned)

---

## License

MIT
