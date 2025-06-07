# 📦 WiseJSON DB

![WiseJSON Logo](logo.png)

[npm version](https://npmjs.org/package/wise-json-db)  
[License](https://github.com/Xzdes/WiseJSON/blob/master/LICENSE)  
[Node.js CI](https://github.com/Xzdes/WiseJSON/actions/workflows/nodejs.yml)

**WiseJSON DB** is an incredibly fast, crash-proof, embedded JSON database for Node.js, supporting batch operations, TTL (Time-To-Live), indexes, and segmented checkpoints. It’s designed for high performance, reliability, and seamless integration into your Node.js applications.

---

## 🚀 Key Features

*   **High Performance:** Optimized read and write operations.
*   **Crash-Proof & Durable:**
    *   **WAL (Write-Ahead Logging):** All changes are first written to a log, ensuring data recovery after crashes.
    *   **Checkpoints:** Periodic snapshots of the database state for quick recovery.
        *   **Segmented Checkpoints:** Large collections are automatically split into segments during checkpointing for better performance and memory management.
        *   **Configurable number of checkpoints to keep.**
    *   **Atomic File Writes:** Safe saving of JSON data and metadata using temporary files and atomic renames.
    *   **Upfront Uniqueness Checks:** For `insert`, `insertMany`, and `update` operations, unique index violations are checked before writing to the WAL, preventing storage of invalid data.
*   **ACID-Compliant Transactions:** Supports atomic transactions across multiple collections, ensuring data consistency.
*   **Indexes:** Unique and non-unique indexes on document fields for significantly faster query operations.
*   **TTL (Time-To-Live):** Automatic removal of expired documents based on lifespan or an exact expiration timestamp.
*   **Batch Operations:** Efficient `insertMany` and `updateMany` for bulk data manipulation.
*   **Embedded & File-Based:** Stores data locally on the file system, requiring no separate server Prozess.
*   **Simple & Intuitive API:** Easy to get started with collections and documents.
*   **Tooling:**
    *   **Basic CLI (`wise-json`):** For core database operations via the command line.
    *   **Data Explorer (web interface & advanced CLI `wisejson-explorer`):** For convenient browsing, exporting, and managing data and indexes.
*   **Lightweight:** Minimal external dependencies (only `uuid` and `proper-lockfile`).
*   **Graceful Shutdown:** Automatic and proper saving of all data when the application terminates मानवtly.
*   **Custom ID Generator:** Allows defining a custom function for generating `_id` field values.
*   **Multi-Process Safety:** Utilizes `proper-lockfile` to prevent data corruption when accessed from multiple Node.js processes.

---

## 📦 Dependencies

WiseJSON DB uses only two runtime dependencies:

*   [`uuid`](https://www.npmjs.com/package/uuid) — for generating unique IDs by default.
*   [`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile) — for safe file locking, ensuring correct behavior when accessed from multiple processes.

Both are installed automatically with:

```bash
npm install wise-json-db
```

If you use a custom build system or bundle WiseJSON DB as part of a more complex package, ensure these packages are also included in your dependencies:

```bash
npm install uuid proper-lockfile
```

---

## 💡 Why WiseJSON DB?

*   **Reliability First:** WAL, checkpoints, and atomic file writes are designed for maximum data safety, even during unexpected failures.
*   **Fast Data Access:** Indexes and optimized operations ensure quick data retrieval and modification.
*   **Easy Integration & Use:** No external services to set up. Start working with your data in minutes.
*   **Full Data Control:** Your data is stored locally, giving you complete control over access and management.
*   **JSON Flexibility:** Works natively with JSON, allowing storage of complex and nested data structures without predefined schemas.

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

// Specify the path where your database will be stored
const dbPath = path.resolve(__dirname, 'myDataBase');

async function main() {
  // Initialize the database with options
  const db = new WiseJSON(dbPath, {
    ttlCleanupIntervalMs: 60000, // Check TTL every 60 seconds
    checkpointIntervalMs: 300000 // Create a checkpoint every 5 minutes
  });
  await db.init(); // Important: wait for DB initialization

  // Get (or create) a collection named 'users'
  const users = await db.collection('users');
  await users.initPromise; // Wait for the collection itself to initialize

  // Insert a single document
  const user1 = await users.insert({ name: 'Alice', age: 30, city: 'New York' });
  console.log('Inserted user:', user1);

  // Batch insert multiple documents
  const userBatch = await users.insertMany([
    { name: 'Bob', age: 24, city: 'London' },
    { name: 'Charlie', age: 35, city: 'Paris', tags: ['dev', 'cat_lover'] }
  ]);
  console.log(`Inserted ${userBatch.length} users in batch.`);

  // Get all documents from the collection
  const allUsers = await users.getAll();
  console.log('All users:', allUsers.length);

  // Find documents matching a condition
  const usersFromLondon = await users.find(user => user.city === 'London');
  console.log('Users from London:', usersFromLondon);

  // Find a single document
  const devUser = await users.findOne(user => user.tags && user.tags.includes('dev'));
  console.log('First developer:', devUser);

  // Update a document
  if (devUser) {
    const updatedDevUser = await users.update(devUser._id, { age: devUser.age + 1, lastLogin: new Date().toISOString() });
    console.log('Updated developer:', updatedDevUser);
  }

  // Batch update documents
  const updatedCount = await users.updateMany(
    (user) => user.age > 30, // Condition for update
    { status: 'senior' }     // Data to update
  );
  console.log(`Updated ${updatedCount} users to senior status.`);

  // Create indexes
  await users.createIndex('city'); // Standard index
  await users.createIndex('name', { unique: true }); // Unique index

  // Find by indexed value
  const usersFromParisByIndex = await users.findByIndexedValue('city', 'Paris');
  console.log('Users from Paris (by index):', usersFromParisByIndex);

  const bobByName = await users.findOneByIndexedValue('name', 'Bob');
  console.log('Bob (by unique name index):', bobByName);

  console.log('Current indexes:', await users.getIndexes());

  // Insert a document with TTL (expires in 5 seconds)
  const temporaryData = await users.insert({
    message: 'This message will self-destruct in 5 seconds',
    expireAt: Date.now() + 5000 // Exact expiration time
    // Alternatively, use: ttl: 5000 (in ms from createdAt)
  });
  console.log('Inserted temporary data (ID):', temporaryData._id);

  // Example of a transaction
  const txn = db.beginTransaction();
  try {
    const logs = await db.collection('logs'); // Ensure logs collection is available
    await logs.initPromise;

    // Operations within the transaction
    await txn.collection('users').insert({ name: 'Diana In Txn', age: 28 });
    await txn.collection('logs').insert({ action: 'USER_CREATED', user: 'Diana In Txn', timestamp: Date.now() });
    
    await txn.commit(); // Apply the transaction
    console.log('Transaction completed successfully.');
  } catch (error) {
    await txn.rollback(); // Rollback changes in case of an error
    console.error('Transaction error, changes rolled back:', error);
  }

  // Collection statistics
  console.log('Users collection stats:', await users.stats());

  // Close the database (important for saving all data)
  await db.close();
  console.log('Database closed.');
}

main().catch(console.error);
```

---

## ⚙️ Configuration

When creating a `WiseJSON` instance, you can pass an options object:

```javascript
const db = new WiseJSON('/path/to/your/db', {
  // Interval for automatic cleanup of expired TTL documents (in milliseconds).
  // Default: 60000 (1 minute)
  ttlCleanupIntervalMs: 60000,

  // Interval for automatic checkpoint creation (in milliseconds).
  // 0 or a negative value disables timed checkpoints.
  // Default: 300000 (5 minutes)
  checkpointIntervalMs: 300000,

  // Maximum number of entries in the WAL file before a checkpoint is forcibly created.
  // 0 or a negative value disables this trigger.
  // Default: 1000
  maxWalEntriesBeforeCheckpoint: 1000,

  // Maximum size of a single data segment in a checkpoint (in bytes).
  // Large collections will be split into multiple segments during checkpointing.
  // Default: 2 * 1024 * 1024 (2MB)
  maxSegmentSizeBytes: 2097152,

  // Number of recent checkpoints to keep. Older ones will be deleted.
  // Minimum value: 1.
  // Default: 5
  checkpointsToKeep: 5,

  // Custom function to generate document _id values.
  // Defaults to a uuid-based generator.
  idGenerator: () => `my-custom-id-${Date.now()}-${Math.random().toString(36).slice(2)}`,

  // Options for reading the WAL file during collection initialization.
  // Default: { recover: false, strict: false }
  //   recover: true - Attempt to recover data by skipping corrupted WAL lines (with a warning).
  //   strict: true - Throw an error on the first WAL line parsing error.
  // If recover=false and strict=false (default), corrupted lines are skipped with a warning.
  walReadOptions: {
    recover: true, 
    strict: false
  },

  // walForceSync: false (rarely used OS-level fsync option for WAL file, default false)
});
```

---

## 🛠️ Command Line Interface (CLI)

WiseJSON DB includes two command-line tools:

### 1️⃣ Basic CLI: `wise-json`

Designed for fundamental database operations. Can be installed globally or used via `npx`.

Example commands:
```bash
# Help
wise-json help

# List all collections
wise-json list

# Collection information (stats, indexes)
wise-json info <collection_name>

# Insert a document (JSON as a string)
wise-json insert <collection_name> '{"name":"John","age":30}'

# Batch insert from data.json file
wise-json insert-many <collection_name> data.json
# Batch insert with a TTL of 1 hour
wise-json insert-many <collection_name> data.json --ttl 3600000

# Find documents (filter is a JSON string supporting operators: $gt, $lt, $in, $regex, $or, $and)
wise-json find <collection_name> '{"age":{"$gt":25}}'
wise-json find <collection_name> '{"$or":[{"city":"London"},{"tags":{"$in":["dev"]}}]}'

# Get document by ID
wise-json get <collection_name> <document_id>

# Remove document by ID
wise-json remove <collection_name> <document_id>

# Clear all documents from a collection
wise-json clear <collection_name>

# Export collection to a file
wise-json export <collection_name> export_data.json

# Import documents from a file into a collection
wise-json import <collection_name> import_data.json
```

**Environment Variables for `wise-json`:**

*   `WISE_JSON_PATH`: Path to the database directory (default: `./wise-json-db-data`).
*   `WISE_JSON_LANG`: CLI interface language (`ru` or `en`, default: `en`).

### 2️⃣ Advanced CLI & Data Explorer: `wisejson-explorer`

This tool provides more advanced data manipulation features, including CSV export, index management, and serves as the backend for the Data Explorer web UI.

Example `wisejson-explorer` commands:
```bash
# Help
wisejson-explorer --help

# List collections
wisejson-explorer list-collections

# Show collection documents with filtering, sorting, pagination
wisejson-explorer show-collection <collection_name> --limit 5 --offset 0 --sort age --order desc --filter '{"city":"London"}'

# Export collection to JSON (default) or CSV
wisejson-explorer export-collection <collection_name> data.json
wisejson-explorer export-collection <collection_name> data.csv --output csv

# Import data into a collection (modes: append, replace)
# Requires --allow-write for write operations
wisejson-explorer import-collection <collection_name> data.json --mode replace --allow-write

# Manage indexes
wisejson-explorer list-indexes <collection_name>
wisejson-explorer create-index <collection_name> <field_name> --unique --allow-write
wisejson-explorer drop-index <collection_name> <field_name> --allow-write
```
By default, `wisejson-explorer` operates in read-only mode. For operations that modify data (import, index creation/deletion), use the `--allow-write` flag.

---

## 🌐 Data Explorer (Web UI)

To run the Data Explorer web interface, use the command:
```bash
node explorer/server.js
# or, if installed globally or as a project dependency:
wisejson-explorer-server
```
The web UI will be available at [http://127.0.0.1:3000](http://127.0.0.1:3000) (default port, can be changed via the `PORT` environment variable).

The Data Explorer allows you to browse collections and documents, apply filters, sort, and paginate. For access protection, you can use the `WISEJSON_AUTH_USER` and `WISEJSON_AUTH_PASS` environment variables.

---

## 🔒 Durability and Fault Tolerance

WiseJSON DB prioritizes data safety:
*   **Write-Ahead Logging (WAL):** Every data modification (insert, update, delete) is first recorded in a WAL file. Only after a successful write to the WAL is the operation applied to the in-memory data. In case of an application or server crash, the WAL file is read upon restart, and any logged operations that weren't fully completed are applied, restoring the database to its state момент the crash.
*   **Checkpoints:** Periodically (or when the WAL reaches a certain size), a complete snapshot (checkpoint) of a collection's data state is created. This significantly speeds up recovery, as only WAL entries made *after* the last successful checkpoint need to be applied. Old checkpoints are automatically pruned.
*   **Atomic File Writes:** When saving checkpoints and other critical data files, a strategy of writing to a temporary file followed by an atomic rename operation is used. This prevents corruption of the main data file if a crash occurs during the write process.
*   **File Locking:** The use of `proper-lockfile` ensures correct operation with database files even with concurrent access from multiple Node.js processes, preventing data races and file corruption.

---

## 🤝 Contributing

We welcome your contributions to make WiseJSON DB even better! You can help by:

*   Reporting bugs
*   Suggesting new features or improvements
*   Submitting Pull Requests with fixes or new code

Please check our contributor guidelines (if available) or simply create an Issue on GitHub.

---

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file for details.

Author: Xzdes ([xzdes@yandex.ru](mailto:xzdes@yandex.ru))