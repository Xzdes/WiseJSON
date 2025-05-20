#!/usr/bin/env node

const path = require('path');
const fs = require('fs/promises');
const WiseJSON = require('../wise-json/index.js');

const db = new WiseJSON('./cli-data');
let collection;

function parseKeyValueArgs(args) {
    const obj = {};
    for (const arg of args) {
        const [key, ...rest] = arg.split('=');
        if (!key || rest.length === 0) continue;
        const value = rest.join('=');
        obj[key] = /^\d+$/.test(value) ? Number(value) : value;
    }
    return obj;
}

async function run() {
    const [,, command, collectionName, ...rest] = process.argv;

    if (!collectionName) {
        console.error('❌ Укажи имя коллекции');
        process.exit(1);
    }

    collection = await db.collection(collectionName);

    if (command === 'insert') {
        const json = parseKeyValueArgs(rest);
        const result = await collection.insert(json);
        console.log('✅ Вставлено:', result);

    } else if (command === 'list') {
        const all = await collection.getAll();
        console.log(`📄 ${all.length} документов:`);
        all.forEach(doc => console.log(doc));

    } else if (command === 'find') {
        const [_, field, value] = rest;
        const found = await collection.findByIndexedValue(field, value);
        console.log(`🔎 Найдено ${found.length}:`);
        found.forEach(doc => console.log(doc));

    } else if (command === 'clear') {
        await collection.clear();
        console.log('🧹 Коллекция очищена.');

    } else {
        console.log('📘 Команды:');
        console.log('  insert <collection> key=value ...');
        console.log('  list <collection>');
        console.log('  find <collection> <field> <value>');
        console.log('  clear <collection>');
    }

    await db.close();
}

run().catch(err => {
    console.error('🔥 Ошибка в CLI:', err.message);
    process.exit(1);
});
