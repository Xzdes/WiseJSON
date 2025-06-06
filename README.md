# WiseJSON Data Explorer

🚀 A powerful, lightweight, and user-friendly tool for managing JSON documents in WiseJSON — manage collections, documents, indexing, exporting, and importing.

---

## 📦 Project Links

- 🐙 GitHub: [https://github.com/Xzdes/WiseJSON](https://github.com/Xzdes/WiseJSON)
- 📦 NPM: [https://www.npmjs.com/package/wise-json-db](https://www.npmjs.com/package/wise-json-db)

---

## ❓ What is WiseJSON?

WiseJSON is a high-performance JSON document database featuring transactions, WAL (write-ahead logging), TTL (document expiration), indexing, and checkpoints for reliable recovery.

WiseJSON Data Explorer is a powerful extension for managing WiseJSON data through:
✅ A flexible CLI  
✅ A minimalistic REST API  
✅ An intuitive web interface

---

## 🚀 Key Features

### 🖥️ CLI (Command Line Interface)

- 📂 **List Collections**  
  `list-collections` — shows all collections with document counts.

- 🔎 **View Collection**  
  `show-collection <collectionName>` — view documents with:
  - `--limit`, `--offset` — pagination
  - `--sort`, `--order` — sorting
  - `--filter` — JSON string filtering
  - `--output json|csv` — output format
  - `--file` — export to a file.

- 📑 **Get Document**  
  `get-document <collectionName> <documentId>` — view a single document.

- 📊 **Collection Stats**  
  `collection-stats <collectionName>` — document count, indexes.

- 🔄 **Import**  
  `import-collection <collectionName> <file.json>` — import JSON data (requires `--allow-write`).

- 💾 **Export**  
  `export-collection <collectionName> <file.json|csv>` — export to JSON or CSV.

- 🔍 **Indexes**  
  - `list-indexes <collectionName>` — list indexes.  
  - `create-index <collectionName> <fieldName> [--unique]` — create index.  
  - `drop-index <collectionName> <fieldName>` — delete index.

---

### 🌐 HTTP API

- `GET /api/collections` — list all collections.
- `GET /api/collections/:name` — get documents with:
  - `limit`, `offset`
  - `sort`, `order`
  - `filter_<field>=value`
- `GET /api/collections/:name/stats` — collection stats.
- `GET /api/collections/:name/doc/:id` — get a single document.

---

### 🖼️ Web Interface

- 📋 Select a collection and view documents.  
- 🔄 Pagination, sorting, filtering.  
- 🔎 View JSON in a textarea (easy to copy).  
- ⚙️ Set the number of documents per page.  
- 🎨 Light purple, adaptive design.  
- 🚀 Fast load with vanilla JS and CSS.

---

## 🌟 Advantages

✅ **Quick to Start** — no dependencies except Node.js, ready to use.  
✅ **ReadOnly Mode by Default** — protects against accidental changes, use `--allow-write` for write operations.  
✅ **Reliable WAL and Checkpoints** — high performance and durability.  
✅ **TTL Support** — automatically remove outdated documents.  
✅ **Indexes** — fast queries on fields.  
✅ **JSON and CSV Exports** — supports flat and nested structures (CSV currently flat).  
✅ **Minimalist, User-Friendly UI** — no frameworks.  
✅ **Cross-platform** — Windows, Linux, macOS.  
✅ **Tested** — extensive CLI and API tests.

---

## ⚠️ Limitations

⚠️ No editing via API yet (CLI only).  
⚠️ CSV export is basic (flattened).  
⚠️ No authentication (planned).  
⚠️ No interactive REPL in CLI yet.  
⚠️ CLI JSON filtering requires escaped quotes on Windows.

---

## 🚀 Getting Started

### 1️⃣ Install

```bash
git clone https://github.com/Xzdes/WiseJSON
cd WiseJSON
npm install
````

---

### 2️⃣ Run the Web Server & API

```bash
npm run start-explorer
```

Then open: [http://127.0.0.1:3000](http://127.0.0.1:3000)

---

### 3️⃣ Use the CLI

```bash
node explorer/cli.js <command> [args] [options]
```

Example:

```bash
node explorer/cli.js import-collection users users.json --mode replace --allow-write
```

---

## 🔒 ReadOnly Mode

All write operations (import, index changes) require the `--allow-write` flag.

---

## 🔍 Filtering

CLI:

```bash
--filter "{\"name\":\"User1\"}"
```

API:

```
/api/collections/users?filter_name=User1
```

---

## 🧪 Testing

```bash
node test/<test_name>.js
```

Test coverage includes:

* CLI: CSV export, errors, ReadOnly
* API: pagination, sorting, filtering
* 404 and error handling

---

## 📁 Project Structure

```
wise-json-npm-package/
├── cli/
├── explorer/
│   ├── cli.js
│   ├── server.js
│   └── views/
├── test/
├── wise-json/
├── package.json
├── README.md
├── README.ru.md
```

---

## 🗓️ Roadmap

* 📝 Editing documents via Web and API.
* 🔍 Full-text search.
* 🔐 Authentication.
* 📈 Advanced CSV export.
* 🎨 Improved UI/UX.

---

## ℹ️ Additional Info

* 📦 NPM: [wise-json-db](https://www.npmjs.com/package/wise-json-db)
* 🐙 GitHub: [Xzdes/WiseJSON](https://github.com/Xzdes/WiseJSON)