# 📦 WiseJSON DB

![WiseJSON Logo](logo.png)

[![NPM Version](https://img.shields.io/npm/v/wise-json-db.svg)](https://npmjs.org/package/wise-json-db)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js CI](https://github.com/Xzdes/WiseJSON/actions/workflows/nodejs.yml/badge.svg)](https://github.com/Xzdes/WiseJSON/actions/workflows/nodejs.yml)
[![Docker Hub](https://img.shields.io/badge/Docker%20Hub-your_username%2Fwisejson--server-blue)](https://hub.docker.com/r/your_username/wisejson-server)

**WiseJSON DB** is an incredibly fast, crash-proof, embedded JSON database for Node.js. It features a powerful sync engine, ACID transactions, and advanced indexing, making it a perfect choice for **offline-first** applications, desktop software, and robust backend services.

---

## 🚀 Quick Start with Docker

The fastest way to get started is by running the WiseJSON server, which includes the **Data Explorer** web UI and the synchronization API, using Docker.

**1. Run the official Docker image:**
```bash
docker run -d -p 3000:3000 \
  -v wisejson_data:/data \
  --name wisejson-server \
  your_dockerhub_username/wisejson-server:latest
```
*(Replace `your_dockerhub_username` with the actual Docker Hub repository name)*

**2. Open the Data Explorer:**
Your server is now running! Navigate to **[http://localhost:3000](http://localhost:3000)** in your browser.

Your database files are safely stored in a Docker volume named `wisejson_data`.

➡️ For detailed instructions on configuration, data persistence, and using Docker Compose, see our **[Comprehensive Docker Guide](DOCKER.md)**.

---

## 💡 Key Features

*   **High Performance:** In-memory indexing and optimized I/O for rapid data access.
*   **Crash-Proof & Durable:**
    *   **WAL (Write-Ahead Logging):** Guarantees data integrity and recovery after crashes.
    *   **Atomic Checkpoints:** Periodic snapshots for fast restarts, with segmentation for large collections.
*   **ACID-Compliant Transactions:** Ensures data consistency across multi-collection operations.
*   **Powerful Querying & Indexing:** Supports unique and non-unique indexes and a rich query syntax (`$gt`, `$in`, `$or`, etc.) for complex lookups.
*   **Ready for Offline-First:** A robust sync engine to seamlessly synchronize local client data with a central server.
*   **Tooling Included:** Comes with a web-based **Data Explorer** and a versatile **Command Line Interface (CLI)**.
*   **Multi-Process Safety:** Uses file locking to prevent data corruption when accessed from multiple Node.js processes.
*   **Lightweight & Simple API:** Minimal dependencies (`uuid`, `proper-lockfile`) and an intuitive, modern API.

---

## 📥 Installation (As a Node.js Library)

To embed WiseJSON DB directly into your Node.js application, install the library from NPM:

```bash
npm install wise-json-db
```

---

## 📚 Basic API Usage

The API is designed to be simple and intuitive, with "lazy" initialization.

```javascript
const { connect } = require('wise-json-db');
const path = require('path');

// `connect` creates a database instance. Initialization happens automatically on the first operation.
const db = connect(path.resolve(__dirname, 'my-app-data'));

async function main() {
  // Getting a collection triggers the initialization if it hasn't happened yet.
  const users = await db.getCollection('users');
  
  await users.clear(); // Clean up for a predictable run

  // Create a unique index to prevent duplicate emails
  await users.createIndex('email', { unique: true });

  // Insert documents
  await users.insert({ name: 'Alice', email: 'alice@example.com', age: 30 });
  await users.insertMany([
    { name: 'Bob', email: 'bob@example.com', age: 24 },
    { name: 'Charlie', email: 'charlie@example.com', age: 35, tags: ['dev'] }
  ]);

  // Find a document using a rich query object
  const devUser = await users.findOne({ tags: 'dev', age: { $gt: 30 } });
  console.log('Developer over 30:', devUser);

  // Update a document using MongoDB-style operators
  const { modifiedCount } = await users.updateOne(
    { email: 'alice@example.com' },
    { $set: { status: 'active' }, $inc: { age: 1 } }
  );
  console.log(`Updated ${modifiedCount} document(s).`);
  
  // Close the database to ensure all data is flushed to disk before the app exits.
  await db.close();
  console.log('Database closed.');
}

main().catch(console.error);
```

For a deeper dive into the API, check out the documentation in the `/docs` directory.

---

## 🛠️ Command Line Interface (CLI)

WiseJSON DB includes a powerful CLI for database administration.

```bash
# See all available commands
wise-json --help

# List all collections in the database
wise-json list-collections

# Show documents with filtering and sorting
wise-json show-collection users --limit 5 --sort age --order desc

# Create an index (requires the --allow-write flag for modifying operations)
wise-json create-index users email --unique --allow-write
```

---
## 🤝 Contributing

Contributions are welcome! Whether it's bug reports, feature suggestions, or pull requests, your help is appreciated. Please feel free to open an issue to discuss your ideas.

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file for details.