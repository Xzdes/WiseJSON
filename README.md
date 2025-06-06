# 📦 WiseJSON DB

![WiseJSON Logo](logo.png)

npm version "https://npmjs.org/package/wise-json-db"
License "https://github.com/Xzdes/WiseJSON/blob/master/LICENSE
Node.js CI "https://github.com/Xzdes/WiseJSON/actions/workflows/nodejs.yml"

**WiseJSON DB** is an incredibly fast, crash-proof, embedded JSON database for Node.js, supporting batch operations, TTL (Time-To-Live), indexes, and segmented checkpoints. It’s designed for high performance, reliability, and seamless integration into your Node.js applications.

---

## 🚀 Key Features

* **High Performance:** Fast read and write operations.
* **Crash-Proof & Durable:**

  * **WAL (Write-Ahead Logging):** All changes are first written to a log for data recovery after crashes.
  * **Checkpoints:** Periodic snapshots for quick recovery.
  * **Segmented Checkpoints:** For better performance on large collections.
  * **Atomic File Writes:** Safe JSON saving using temporary files.
* **ACID Transactions:** Atomic transactions across multiple collections.
* **Indexes:** Unique and non-unique indexes for faster queries.
* **TTL (Time-To-Live):** Automatic removal of expired documents.
* **Batch Operations:** Efficient `insertMany` and `updateMany`.
* **Embedded & File-Based:** Stores data locally without a separate server.
* **Simple API:** Intuitive work with collections and documents.
* **Tooling:**

  * **Basic CLI (`wise-json`):** For core DB operations.
  * **Data Explorer (web interface & advanced CLI `wisejson-explorer`).**
* **Lightweight:** Minimal dependencies (only `uuid`).
* **Graceful Shutdown:** Automatic data saving on proper application termination.
* **Custom ID Generator:** Allows you to set your own `_id` function.

---

## 💡 Why WiseJSON DB?

* **Reliability:** WAL and checkpoints ensure data safety even during crashes.
* **Speed:** Indexes and optimization speed up data access.
* **Easy Integration:** No external services required.
* **Full Control:** Data is stored locally.
* **JSON Flexibility:** Natively stores complex structured data.

---

## 📥 Installation

```bash
npm install wise-json-db
# or
yarn add wise-json-db
```

---

## 📚 Basic Usage (API)

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

const dbPath = path.resolve(__dirname, 'myDataBase');

async function main() {
  const db = new WiseJSON(dbPath, {
    ttlCleanupIntervalMs: 60000
  });
  await db.init();

  const users = await db.collection('users');
  await users.initPromise;

  const user1 = await users.insert({ name: 'Alice', age: 30, city: 'New York' });
  console.log('Inserted user:', user1);

  const userBatch = await users.insertMany([
    { name: 'Bob', age: 24, city: 'London' },
    { name: 'Charlie', age: 35, city: 'Paris', tags: ['dev', 'cat_lover'] }
  ]);
  console.log(`Inserted ${userBatch.length} users.`);

  const allUsers = await users.getAll();
  console.log('All users:', allUsers.length);

  const usersFromLondon = await users.find(user => user.city === 'London');
  console.log('Users from London:', usersFromLondon);

  const devUser = await users.findOne(user => user.tags && user.tags.includes('dev'));
  console.log('First developer:', devUser);

  if (devUser) {
    const updatedDevUser = await users.update(devUser._id, { age: devUser.age + 1, lastLogin: new Date().toISOString() });
    console.log('Updated developer:', updatedDevUser);
  }

  const updatedCount = await users.updateMany(
    (user) => user.age > 30,
    { status: 'senior' }
  );
  console.log(`Updated ${updatedCount} users (status senior).`);

  await users.createIndex('city');
  await users.createIndex('name', { unique: true });

  const usersFromParisByIndex = await users.findByIndexedValue('city', 'Paris');
  console.log('Users from Paris (by index):', usersFromParisByIndex);

  const bobByName = await users.findOneByIndexedValue('name', 'Bob');
  console.log('Bob (by unique name index):', bobByName);

  console.log('Current indexes:', await users.getIndexes());

  const temporaryData = await users.insert({
    message: 'This message will self-destruct in 5 seconds',
    expireAt: Date.now() + 5000
  });
  console.log('Inserted temporary data:', temporaryData._id);

  const txn = db.beginTransaction();
  try {
    const logs = await db.collection('logs');
    await logs.initPromise;

    await txn.collection('users').insert({ name: 'Diana In Txn', age: 28 });
    await txn.collection('logs').insert({ action: 'USER_CREATED', user: 'Diana In Txn', timestamp: Date.now() });
    await txn.commit();
    console.log('Transaction completed successfully.');
  } catch (error) {
    await txn.rollback();
    console.error('Transaction error, changes rolled back:', error);
  }

  console.log('Users collection stats:', await users.stats());

  await db.close();
  console.log('Database closed.');
}

main().catch(console.error);
```

---

## 🛠️ Command Line Interface (CLI)

WiseJSON DB includes two CLI tools:

### 1️⃣ Basic CLI: `wise-json`

Example:

```bash
wise-json help
wise-json list
wise-json info <collection_name>
wise-json insert <collection_name> '{"name":"John","age":30}'
wise-json insert-many <collection_name> data.json
wise-json insert-many <collection_name> data.json --ttl 3600000
wise-json find <collection_name> '{"age":30}'
wise-json get <collection_name> <document_id>
wise-json remove <collection_name> <document_id>
wise-json clear <collection_name>
wise-json export <collection_name> export_data.json
wise-json import <collection_name> import_data.json
```

**Environment Variables:**

* `WISE_JSON_PATH`: Path to the database directory (default: `./wise-json-db-data`).
* `WISE_JSON_LANG`: CLI language (`ru` or `en`, default: `en`).

### 2️⃣ Advanced CLI: `wisejson-explorer`

Example:

```bash
wisejson-explorer --help
wisejson-explorer list-collections
wisejson-explorer show-collection <collection_name> --limit 5 --offset 0 --sort age --order desc
wisejson-explorer export-collection <collection_name> data.json
wisejson-explorer export-collection <collection_name> data.csv --output csv
wisejson-explorer import-collection <collection_name> data.json --mode replace --allow-write
wisejson-explorer create-index <collection_name> <field_name> --unique --allow-write
```

By default, `wisejson-explorer` runs in read-only mode. Use `--allow-write` for modifying data.

---

## 🌐 Data Explorer (Web UI)

To run:

```bash
node explorer/server.js
# or
wisejson-explorer-server
```

Default: [http://127.0.0.1:3000](http://127.0.0.1:3000).

---

## ⚙️ Configuration

```javascript
const db = new WiseJSON('/path/to/db', {
  ttlCleanupIntervalMs: 60000,
  checkpointIntervalMs: 300000,
  maxWalEntriesBeforeCheckpoint: 1000,
  maxSegmentSizeBytes: 2 * 1024 * 1024,
  checkpointsToKeep: 5,
  idGenerator: () => `custom_${Date.now()}`,
  walForceSync: false
});
```

---

## 🔒 Durability and Fault Tolerance

WiseJSON DB uses WAL and checkpoints for data safety. WAL ensures recovery after crashes, while checkpoints capture the database state. Data is written atomically using temporary files.

---

## 🤝 Contributing

We welcome:

* Bug reports
* Feature suggestions
* Pull Requests

---

## 📄 License

MIT License. Author: Xzdes [xzdes@yandex.ru](mailto:xzdes@yandex.ru)
